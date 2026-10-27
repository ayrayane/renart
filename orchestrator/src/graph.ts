import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Code graph of a repository at a commit, built with CodeGraph (tree-sitter + SQLite, no LLM, no API key).
// A Kubernetes Job builds the snapshot (checked-out files + .codegraph index) with its own memory, then uploads
// it here; the orchestrator keeps it per project and SHA and answers the runs' queries. Runs never get the graph.

export type Exec = (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string; stderr: string }>
const run: Exec = (cmd, args, opts) => promisify(execFile)(cmd, args, { ...opts, maxBuffer: 16 * 1024 * 1024 })

export const GRAPH_TOOLS = ['code_graph_explore', 'code_graph_callers', 'code_graph_impact', 'code_graph_affected']
export const KEEP_PER_PROJECT = 5
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3
const CODEGRAPH = fileURLToPath(new URL('../node_modules/.bin/codegraph', import.meta.url))

// A run proves which run it is; a build Job proves which snapshot it uploads. Derived, so they survive restarts.
const hmac = (secret: string, what: string) => createHmac('sha256', secret).update(what).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export const runToken = (secret: string, runId: string) => hmac(secret, `graph:${runId}`)
export const validToken = (secret: string, runId: string, token: string) => same(runToken(secret, runId), token)
export const uploadToken = (secret: string, project: string, sha: string) => hmac(secret, `build:${project}@${sha}`)
export const validUpload = (secret: string, project: string, sha: string, token: string) => same(uploadToken(secret, project, sha), token)

// One Job per project@sha, named so that a second request (or a restarted orchestrator) finds the same one.
export const graphJobName = (project: string, sha: string) => `graph-${sha.slice(0, 12)}-${createHash('sha256').update(project).digest('hex').slice(0, 8)}`

// What the model may pass on: plain names, paths and questions, never something the CLI would read as a flag.
export function cleanArg(value: unknown, max = 300): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('empty argument')
  const v = value.trim().slice(0, max)
  if (v.startsWith('-')) throw new Error('arguments cannot start with "-"')
  return v
}

// Only what git and CodeGraph need: no token or key, telemetry, daemon and self-download off.
// HOME must not be the repository: CodeGraph refuses to index what looks like a home directory.
export const toolEnv = (caFile?: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: tmpdir(), NO_COLOR: '1',
  CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_UPDATE_CHECK: '1',
  ...(caFile ? { GIT_SSL_CAINFO: caFile } : {}),
})

export interface SnapshotSpec { dir: string; gitlabUrl: string; botToken: string; caFile?: string; project: string; ref: string; sha: string; codegraph?: string; exec?: Exec }

// Runs inside the build Job: the files of project@sha in `dir`, indexed. Refuses a ref that moved.
export async function buildSnapshot(s: SnapshotSpec) {
  const exec = s.exec ?? run
  await mkdir(s.dir, { recursive: true })
  const env = {
    ...toolEnv(s.caFile), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${s.botToken}`).toString('base64')}`,
  }
  const url = `${s.gitlabUrl.replace(/\/$/, '')}/${s.project}.git`
  await exec('git', ['init', '-q', '.'], { cwd: s.dir, env, timeout: 30_000 })
  await exec('git', ['-c', 'core.symlinks=false', 'fetch', '-q', '--depth', '1', url, s.ref], { cwd: s.dir, env, timeout: 600_000 })
  await exec('git', ['-c', 'core.symlinks=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: s.dir, env, timeout: 300_000 })
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: s.dir, env, timeout: 10_000 })).stdout.trim()
  if (head !== s.sha) throw new Error(`ref ${s.ref} is at ${head}, expected ${s.sha}`)
  await rm(join(s.dir, '.git'), { recursive: true, force: true })
  await exec(s.codegraph ?? CODEGRAPH, ['init', '.', '--yes'], { cwd: s.dir, env: toolEnv(s.caFile), timeout: 1_800_000 })
}

export interface GraphJobs {
  // Starts the build Job (a Job that already exists is fine).
  start(name: string, target: { project: string; ref: string; sha: string }): Promise<void>
  status(name: string): Promise<'running' | 'succeeded' | 'failed' | 'missing'>
}

export interface GraphConfig {
  dir: string
  jobs: GraphJobs
  codegraph?: string
  exec?: Exec
  waitMs?: number
  pollMs?: number
}

export function graphStore(cfg: GraphConfig) {
  const exec = cfg.exec ?? run
  const bin = cfg.codegraph ?? CODEGRAPH
  const waiting = new Map<string, Promise<string>>()
  const projectDir = (project: string) => join(cfg.dir, encodeURIComponent(project))
  const snapshot = (project: string, sha: string) => join(projectDir(project), sha)
  const ready = (dir: string) => stat(join(dir, '.codegraph')).then(() => true, () => false)

  // Keep the most recent snapshots of a project only.
  async function prune(project: string) {
    const shas = (await readdir(projectDir(project)).catch(() => [] as string[])).filter((s) => !s.endsWith('.partial'))
    const dated = await Promise.all(shas.map(async (s) => ({ s, t: (await stat(join(projectDir(project), s))).mtimeMs })))
    for (const { s } of dated.sort((a, b) => b.t - a.t).slice(KEEP_PER_PROJECT)) await rm(join(projectDir(project), s), { recursive: true, force: true })
  }

  return {
    // The snapshot of project@sha: already here, or built by its Job and uploaded. Concurrent callers share the wait.
    ensure(project: string, ref: string, sha: string): Promise<string> {
      const key = `${project}@${sha}`
      const existing = waiting.get(key)
      if (existing) return existing
      const p = (async () => {
        const dir = snapshot(project, sha)
        if (await ready(dir)) return dir
        const name = graphJobName(project, sha)
        await cfg.jobs.start(name, { project, ref, sha })
        const deadline = Date.now() + (cfg.waitMs ?? 30 * 60_000)
        while (Date.now() < deadline) {
          if (await ready(dir)) return dir
          const status = await cfg.jobs.status(name)
          // A finished Job's upload is already on disk; give it one last look before giving up.
          if (status !== 'running' && (await ready(dir))) return dir
          if (status === 'failed') throw new Error(`code graph build ${name} failed`)
          if (status === 'missing' || status === 'succeeded') throw new Error(`code graph build ${name} ended without a snapshot`)
          await sleep(cfg.pollMs ?? 2000)
        }
        throw new Error(`code graph build ${name} timed out`)
      })()
      waiting.set(key, p)
      p.catch(() => {}).finally(() => waiting.delete(key))
      return p
    },

    // The build Job's upload: a gzipped tar of the snapshot, unpacked next to its place and renamed (complete or absent).
    async receive(project: string, sha: string, body: Readable) {
      const partial = `${snapshot(project, sha)}.partial`
      await rm(partial, { recursive: true, force: true })
      await mkdir(partial, { recursive: true })
      try {
        let bytes = 0
        const limit = new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length
            done(bytes > MAX_UPLOAD_BYTES ? new Error('snapshot too large') : null, chunk)
          },
        })
        // GNU tar drops leading "/" and refuses ".." members; ownership and modes are not taken from the archive.
        const tar = spawn('tar', ['-xzf', '-', '-C', partial, '--no-same-owner', '--no-same-permissions'], { stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        tar.stderr.on('data', (d) => { stderr += d })
        const exited = new Promise<number>((resolve) => tar.on('close', resolve))
        await pipeline(body, limit, tar.stdin)
        const code = await exited
        if (code !== 0) throw new Error(`tar: ${stderr.slice(0, 300)}`)
        if (!(await ready(partial))) throw new Error('upload has no .codegraph index')
        // Files and directories only: a symlink in the archive could point the later queries outside the snapshot.
        const odd = (await exec('find', [partial, '!', '-type', 'f', '!', '-type', 'd', '-print', '-quit'], { env: toolEnv(), timeout: 60_000 })).stdout.trim()
        if (odd) throw new Error(`upload holds a link or special file: ${odd.slice(partial.length + 1, partial.length + 120)}`)
        await rm(snapshot(project, sha), { recursive: true, force: true })
        await rename(partial, snapshot(project, sha))
        await prune(project)
      } catch (e) {
        await rm(partial, { recursive: true, force: true })
        throw e
      }
    },

    async query(dir: string, tool: string, args: Record<string, unknown>) {
      const files = Array.isArray(args.files) ? args.files.slice(0, 50).map((f) => cleanArg(f)) : []
      const argv = tool === 'code_graph_explore' ? ['explore', cleanArg(args.question), '--max-files', '3']
        : tool === 'code_graph_callers' ? ['callers', cleanArg(args.symbol), '--limit', '30']
          : tool === 'code_graph_impact' ? ['impact', cleanArg(args.symbol), '--depth', '2']
            : tool === 'code_graph_affected' ? ['affected', ...(files.length ? files : [cleanArg(undefined)])]
              : null
      if (!argv) throw new Error(`unknown graph tool ${tool}`)
      const out = await exec(bin, [...argv, '-p', dir], { cwd: dir, env: toolEnv(), timeout: 60_000 })
        .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }))
      return `${out.stdout}${out.stderr}`.slice(0, 16_000)
    },
  }
}
