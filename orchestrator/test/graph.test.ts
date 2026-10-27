import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { graphStore, buildSnapshot, runToken, validToken, uploadToken, validUpload, graphJobName, cleanArg, type Exec, type GraphJobs } from '../src/graph.ts'
import { buildGraphJob } from '../src/runs.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
// The archive is built up front: a child's stdout is not a reliable stream to hand over later in a test.
const tarOf = (dir: string) => Readable.from([execFileSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 64 * 1024 * 1024 })])

test('run and upload tokens are bound to what they prove', () => {
  assert.ok(validToken('s', 'run-a', runToken('s', 'run-a')))
  assert.ok(!validToken('s', 'run-b', runToken('s', 'run-a')))
  assert.ok(validUpload('s', 'g/p', 'abc', uploadToken('s', 'g/p', 'abc')))
  assert.ok(!validUpload('s', 'g/p', 'def', uploadToken('s', 'g/p', 'abc')))
  assert.ok(!validUpload('s', 'g/other', 'abc', uploadToken('s', 'g/p', 'abc')))
  assert.ok(!validUpload('s', 'g/p', 'abc', 'short'))
})

test('build Job names are stable, short and valid Kubernetes names', () => {
  const sha = 'ae217ff34011d5bca763ae5753c2aa18e34b48cc'
  const n = graphJobName('group/app', sha)
  assert.equal(n, graphJobName('group/app', sha))
  assert.notEqual(n, graphJobName('group/other', sha))
  assert.match(n, /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/)
})

test('model arguments can never become CLI flags', () => {
  assert.equal(cleanArg('  signed '), 'signed')
  assert.throws(() => cleanArg('--path=/etc'), /cannot start/)
  assert.throws(() => cleanArg(''), /empty/)
})

// Jobs that "build" by writing the snapshot into the store after a short delay, as an upload would.
function fakeJobs(store: () => ReturnType<typeof graphStore>, outcome: 'upload' | 'fail' | 'vanish' = 'upload') {
  const started: string[] = []
  const state = new Map<string, 'running' | 'succeeded' | 'failed' | 'missing'>()
  const jobs: GraphJobs = {
    async start(name, t) {
      started.push(name)
      state.set(name, 'running')
      setTimeout(async () => {
        if (outcome === 'upload') {
          const src = tmp('snap-')
          mkdirSync(join(src, '.codegraph'))
          writeFileSync(join(src, 'calc.py'), 'x = 1\n')
          await store().receive(t.project, t.sha, tarOf(src))
          state.set(name, 'succeeded')
        } else state.set(name, outcome === 'fail' ? 'failed' : 'missing')
      }, 30)
    },
    async status(name) { return state.get(name) ?? 'missing' },
  }
  return { jobs, started }
}

test('one build Job per commit, shared by concurrent callers; later calls use the snapshot on disk', async () => {
  let store!: ReturnType<typeof graphStore>
  const { jobs, started } = fakeJobs(() => store)
  store = graphStore({ dir: tmp('graphs-'), jobs, pollMs: 10 })
  const [a, b] = await Promise.all([store.ensure('g/p', 'refs/heads/main', 'abc'), store.ensure('g/p', 'refs/heads/main', 'abc')])
  assert.equal(a, b)
  assert.ok(existsSync(join(a, '.codegraph')) && existsSync(join(a, 'calc.py')))
  await store.ensure('g/p', 'refs/heads/main', 'abc')
  assert.equal(started.length, 1)
})

test('a failed or vanished build Job is reported, not waited on forever', async () => {
  for (const outcome of ['fail', 'vanish'] as const) {
    let store!: ReturnType<typeof graphStore>
    const { jobs } = fakeJobs(() => store, outcome)
    store = graphStore({ dir: tmp('graphs-'), jobs, pollMs: 10 })
    await assert.rejects(store.ensure('g/p', 'refs/heads/main', 'abc'), outcome === 'fail' ? /failed/ : /without a snapshot/)
  }
  const never: GraphJobs = { start: async () => {}, status: async () => 'running' }
  await assert.rejects(graphStore({ dir: tmp('graphs-'), jobs: never, waitMs: 50, pollMs: 10 }).ensure('g/p', 'r', 'abc'), /timed out/)
})

test('uploads: no index is refused, nothing escapes the snapshot directory, only 5 snapshots kept', async () => {
  const dir = tmp('graphs-')
  const store = graphStore({ dir, jobs: { start: async () => {}, status: async () => 'running' } })
  await assert.rejects(store.receive('g/p', 'abc', tarOf(tmp('empty-'))), /no \.codegraph/)
  assert.ok(!existsSync(join(dir, encodeURIComponent('g/p'), 'abc.partial')))

  // An archive with a "../" member, built by hand: GNU tar must not write outside.
  const evil = tmp('evil-')
  execFileSync('python3', ['-c', `
import tarfile, io, sys
t = tarfile.open(sys.argv[1], 'w:gz')
for name, data in [('.codegraph/db', b'x'), ('../escaped.txt', b'pwned')]:
    i = tarfile.TarInfo(name); i.size = len(data); t.addfile(i, io.BytesIO(data))
t.close()`, join(evil, 'a.tgz')])
  await store.receive('g/p', 'evil', Readable.from(execFileSync('cat', [join(evil, 'a.tgz')]))).catch(() => {})
  assert.ok(!existsSync(join(dir, encodeURIComponent('g/p'), 'escaped.txt')))

  // A symlink inside the archive is refused, even when it points nowhere harmful yet.
  const linked = tmp('link-'); mkdirSync(join(linked, '.codegraph')); symlinkSync('/etc/passwd', join(linked, 'calc.py'))
  await assert.rejects(store.receive('g/p', 'linked', tarOf(linked)), /link or special file/)

  for (let i = 0; i < 7; i++) {
    const src = tmp('snap-'); mkdirSync(join(src, '.codegraph'))
    await store.receive('g/p', `sha${i}`, tarOf(src))
  }
  assert.ok(readdirSync(join(dir, encodeURIComponent('g/p'))).length <= 5)
})

test('buildSnapshot refuses a ref that moved and never hands the bot token to CodeGraph', async () => {
  const envs: [string, NodeJS.ProcessEnv][] = []
  const exec: Exec = async (cmd, args, opts) => {
    envs.push([cmd, opts.env])
    return { stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'abc\n' : '', stderr: '' }
  }
  await buildSnapshot({ dir: tmp('b-'), gitlabUrl: 'https://gl', botToken: 'bot-secret', project: 'g/p', ref: 'r', sha: 'abc', exec, codegraph: '/cg' })
  const cg = envs.find(([cmd]) => cmd === '/cg')![1]
  assert.ok(!JSON.stringify(cg).includes('bot-secret') && !JSON.stringify(cg).includes(Buffer.from('oauth2:bot-secret').toString('base64')))
  assert.equal(cg.CODEGRAPH_TELEMETRY, '0')
  await assert.rejects(buildSnapshot({ dir: tmp('b-'), gitlabUrl: 'https://gl', botToken: 't', project: 'g/p', ref: 'r', sha: 'other', exec, codegraph: '/cg' }), /expected other/)
})

test('the build Job gets the bot token, its own memory and the upload target, never a user token', () => {
  const cfg = { namespace: 'renart', image: 'runner:1', graphImage: 'orch:1', graphMemory: '6Gi', gitlabUrl: 'https://gl', anthropicSecret: 'a', botSecret: 'renart-bot', caConfigMap: 'ca' }
  const job = buildGraphJob(cfg, { name: 'graph-x', project: 'g/p', ref: 'refs/heads/main', sha: 'abc', uploadUrl: 'http://o/internal/graph-snapshot', uploadToken: 'tok' })
  const c = job.spec!.template.spec!.containers[0]
  assert.equal(c.image, 'orch:1')
  assert.deepEqual(c.command, ['node', 'src/graph-builder.ts'])
  assert.equal(c.resources!.limits!.memory, '6Gi')
  assert.deepEqual(c.env!.find((e) => e.name === 'GITLAB_TOKEN')!.valueFrom, { secretKeyRef: { name: 'renart-bot', key: 'GITLAB_TOKEN' } })
  assert.ok(!c.envFrom, 'no Anthropic secret in a build')
  assert.equal(job.metadata!.labels!['renart.dev/graph-build'], 'graph-x')
  assert.ok(!('renart.dev/run' in job.metadata!.labels!), 'not mistaken for a run by the audit')
})

test('real CodeGraph end to end: build from a git repo, upload as tar, query callers and impact', async () => {
  const base = tmp('remote-')
  const work = tmp('work-')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
  git(base, 'init', '-q', '--bare', '-b', 'main', 'proj.git')
  git(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'calc.py'), 'def divide(a, b):\n    return a / b\n\n\ndef average(v):\n    return divide(sum(v), len(v))\n')
  git(work, 'add', '-A'); git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git(work, 'push', '-q', join(base, 'proj.git'), 'main')
  const sha = git(work, 'rev-parse', 'HEAD')
  const built = join(tmp('job-'), 'snapshot')
  await buildSnapshot({ dir: built, gitlabUrl: `file://${base}`, botToken: 't', project: 'proj', ref: 'refs/heads/main', sha })
  const store = graphStore({ dir: tmp('graphs-'), jobs: { start: async () => {}, status: async () => 'running' } })
  await store.receive('proj', sha, tarOf(built))
  const snap = await store.ensure('proj', 'refs/heads/main', sha)
  assert.match(await store.query(snap, 'code_graph_callers', { symbol: 'divide' }), /average/)
  assert.match(await store.query(snap, 'code_graph_impact', { symbol: 'divide' }), /average/)
})
