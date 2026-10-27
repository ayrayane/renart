import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRepo, fileGuard, insideWorkspace } from '../src/workspace.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'renart-'))
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

test('paths outside the clone or inside .git are refused', () => {
  const root = tmp()
  assert.ok(insideWorkspace(root, 'src/new-file.ts'))
  assert.ok(insideWorkspace(root, join(root, 'a.txt')))
  assert.ok(!insideWorkspace(root, '/proc/self/environ'))
  assert.ok(!insideWorkspace(root, '../outside'))
  assert.ok(!insideWorkspace(root, '.git/config'))
  symlinkSync('/etc', join(root, 'escape'))
  assert.ok(!insideWorkspace(root, 'escape/passwd'))
})

test('the hook denies shell and out-of-tree file access, allows MCP and in-tree files', async () => {
  const root = tmp()
  const guard = fileGuard(root)
  const call = (tool_name: string, tool_input: unknown) =>
    guard({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: root } as never, 't', { signal: new AbortController().signal })
  const denied = async (r: Promise<unknown>) => ((await r) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny'
  assert.ok(await denied(call('Bash', { command: 'env' })))
  assert.ok(await denied(call('Read', { file_path: '/proc/self/environ' })))
  assert.ok(await denied(call('Grep', { pattern: 'x', path: '/home' })))
  assert.ok(!(await denied(call('Read', { file_path: join(root, 'README.md') }))))
  assert.ok(!(await denied(call('Glob', { pattern: '**/*.ts' }))))
  assert.ok(!(await denied(call('mcp__gitlab__get_issue', { iid: 1 }))))
})

test('clone neutralises symlinks; commitAndPush pushes a new branch and refuses an empty commit', async () => {
  const remote = tmp()
  const seed = tmp()
  git(remote, 'init', '-q', '--bare', '-b', 'main', 'origin.git'); git(join(remote, 'origin.git'), 'config', 'receive.advertisePushOptions', 'true')
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  symlinkSync('/etc/passwd', join(seed, 'link'))
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git(seed, 'push', '-q', join(remote, 'origin.git'), 'main')

  const ws = await cloneRepo(`file://${remote}`, 'token', 'origin', join(tmp(), 'repo'))
  assert.equal(ws.baseBranch, 'main')
  assert.ok(!lstatSync(join(ws.dir, 'link')).isSymbolicLink())
  await assert.rejects(ws.commitAndPush('renart/empty', 'nothing', { name: 'A', email: 'a@x' }), /no file changes/)

  writeFileSync(join(ws.dir, 'a.txt'), 'two\n')
  await ws.commitAndPush('renart/run-1', 'change a', { name: 'Alice', email: 'a@x' })
  assert.equal(git(join(remote, 'origin.git'), 'log', '-1', '--format=%an <%ae> / %cn: %s', 'renart/run-1').trim(), 'Alice <a@x> / Renart: change a')
  assert.equal(readFileSync(join(ws.dir, 'a.txt'), 'utf8'), 'two\n')
})

test('a pipeline fix clones the branch the pipeline ran on, and its merge request targets that branch', async () => {
  const remote = tmp()
  const seed = tmp()
  git(remote, 'init', '-q', '--bare', '-b', 'main', 'origin.git'); git(join(remote, 'origin.git'), 'config', 'receive.advertisePushOptions', 'true')
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'main\n')
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git(seed, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(seed, 'a.txt'), 'feature\n')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'feature')
  git(seed, 'push', '-q', join(remote, 'origin.git'), 'main', 'feature')

  const ws = await cloneRepo(`file://${remote}`, 'token', 'origin', join(tmp(), 'repo'), 'feature')
  assert.equal(ws.baseBranch, 'feature')
  assert.equal(readFileSync(join(ws.dir, 'a.txt'), 'utf8'), 'feature\n')
})

test('mergeFrom leaves the conflicts to resolve; a commit with a marker left is refused, a resolved one is a merge', async () => {
  const remote = tmp()
  const seed = tmp()
  const commit = (msg: string) => git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg)
  git(remote, 'init', '-q', '--bare', '-b', 'main', 'origin.git'); git(join(remote, 'origin.git'), 'config', 'receive.advertisePushOptions', 'true')
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'base\n')
  git(seed, 'add', '-A'); commit('base')
  git(seed, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(seed, 'a.txt'), 'feature\n'); commit('feature')
  git(seed, 'checkout', '-q', 'main')
  writeFileSync(join(seed, 'a.txt'), 'main\n'); commit('main')
  git(seed, 'push', '-q', join(remote, 'origin.git'), 'main', 'feature')

  const ws = await cloneRepo(`file://${remote}`, 'token', 'origin', join(tmp(), 'repo'), 'feature')
  assert.deepEqual(await ws.mergeFrom('main'), ['a.txt'])
  await assert.rejects(ws.commitAndPush('renart/conflicts', 'merge main', { name: 'A', email: 'a@x' }), /conflict markers/)
  writeFileSync(join(ws.dir, 'a.txt'), 'feature and main\n')
  await ws.commitAndPush('renart/conflicts', 'merge main', { name: 'A', email: 'a@x' })
  // Two parents: a real merge, so GitLab sees the conflict as resolved once this lands on feature.
  assert.equal(git(join(remote, 'origin.git'), 'log', '-1', '--format=%p', 'renart/conflicts').trim().split(' ').length, 2)
})
