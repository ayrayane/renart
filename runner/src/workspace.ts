import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

const exec = promisify(execFile)

export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']

// Git over HTTPS with the user's token in a header, never in the remote URL or .git/config.
function gitEnv(token: string) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.NODE_EXTRA_CA_CERTS ? { GIT_SSL_CAINFO: process.env.NODE_EXTRA_CA_CERTS } : {}),
  }
}

export interface Workspace {
  dir: string
  // The branch checked out, which a merge request from this workspace targets: the default one, or the one asked for.
  baseBranch: string
  // Commits everything and pushes it as a new branch; throws if nothing changed or a conflict marker is left.
  commitAndPush(branch: string, message: string, author: { name: string; email: string }): Promise<void>
  // Merges `target` into the checked-out branch without committing; returns the files left in conflict.
  mergeFrom(target: string): Promise<string[]>
}

export async function cloneRepo(gitlabUrl: string, token: string, project: string, dir: string, branch?: string): Promise<Workspace> {
  const env = gitEnv(token)
  const url = `${gitlabUrl.replace(/\/$/, '')}/${project}.git`
  // core.symlinks=false: a symlink in the repo is checked out as a plain file, so it cannot point the agent outside the clone.
  await exec('git', ['clone', '--depth', '1', '-c', 'core.symlinks=false', ...(branch ? ['--branch', branch] : []), url, dir], { env })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env })
  const baseBranch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  return {
    dir,
    baseBranch,
    async commitAndPush(branch, message, author) {
      await git('add', '-A')
      if (!(await git('status', '--porcelain')).stdout.trim()) throw new Error('no file changes to commit')
      const markers = (await git('diff', '--cached', '-U0')).stdout.split('\n').filter((l) => /^\+(<{7}|>{7}) /.test(l))
      if (markers.length) throw new Error(`conflict markers left in the changes: ${markers.slice(0, 3).join(' | ')}`)
      // The user who asked is the author; Renart, who typed it, is the committer.
      await git('-c', 'user.name=Renart', '-c', 'user.email=renart@users.noreply', 'commit', '--author', `${author.name} <${author.email}>`, '-m', message)
      // Committed where it stands (a branch switch would drop an ongoing merge) and pushed under the new branch name.
      // ci.skip: a pipeline started by this push would run the agent's code with the bot's rights; a person starts it.
      await git('push', '-o', 'ci.skip', 'origin', `HEAD:refs/heads/${branch}`)
    },
    async mergeFrom(target) {
      // A merge needs the common history: the clone is shallow.
      await git('fetch', '-q', '--unshallow', 'origin')
      await git('fetch', '-q', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`)
      // Exits non-zero on conflicts, which is the expected case here.
      await git('-c', 'user.name=Renart', '-c', 'user.email=renart@users.noreply', 'merge', '--no-commit', '--no-ff', `origin/${target}`).catch(() => {})
      return (await git('diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)
    },
  }
}

// realpath of the deepest existing ancestor, so a not-yet-created file is judged by where it would land.
function realish(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : resolve(realish(parent), relative(parent, p))
  }
}

export function insideWorkspace(root: string, p: string): boolean {
  const base = realpathSync(root)
  const target = realish(isAbsolute(p) ? p : resolve(base, p))
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  return rel !== '.git' && !rel.startsWith(`.git${sep}`)
}

// Runs before every tool call, auto-allowed ones included: file tools only inside the clone (outside .git), MCP tools as configured, nothing else.
export function fileGuard(root: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name.startsWith('mcp__')) return {}
    const args = (input.tool_input ?? {}) as Record<string, unknown>
    const path = (args.file_path ?? args.path ?? '.') as string
    // Glob's pattern and Grep's glob are paths too (Grep's pattern is a regex): no absolute path, no way up.
    const pathPattern = input.tool_name === 'Glob' ? args.pattern : input.tool_name === 'Grep' ? args.glob : undefined
    const escapes = typeof pathPattern === 'string' && (isAbsolute(pathPattern) || pathPattern.split(/[\\/]/).includes('..'))
    const allowed = FILE_TOOLS.includes(input.tool_name) && typeof path === 'string' && insideWorkspace(root, path) && !escapes
    if (allowed) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${input.tool_name} on ${path} is outside the repository workspace`,
      },
    }
  }
}
