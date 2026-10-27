import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RepoReader } from '../src/gitlab.ts'
import { workflowStore } from '../src/workflows.ts'

const wf = (id: string, context: string, label = id) =>
  `id: ${id}\nlabel: ${label}\ncontext: ${context}\ntools: [get_merge_request]\nprompt: do ${id}\n`

// In-memory repos: project -> { sha, files: path -> content }.
function fakeRepo(repos: Record<string, { sha: string; files: Record<string, string> }>) {
  const reads: string[] = []
  const reader: RepoReader = {
    async headSha(p) { return repos[p]?.sha ?? null },
    async listFiles(p, dir) {
      return Object.keys(repos[p]?.files ?? {}).filter((f) => f.slice(0, f.lastIndexOf('/') + 1) === (dir ? `${dir}/` : ''))
    },
    async readFile(p, path) { reads.push(`${p}:${path}`); return repos[p].files[path] },
  }
  return { reader, reads, repos }
}

test('merges instance and repo workflows, filters by context; a repo cannot replace an instance workflow', async () => {
  const { reader } = fakeRepo({
    'renart/workflows': { sha: 'a', files: { 'summarize-mr.yaml': wf('summarize-mr', 'merge_request'), 'plan.yaml': wf('plan', 'issue') } },
    'team/app': { sha: 'b', files: {
      '.renart/workflows/summarize-mr.yml': wf('summarize-mr', 'merge_request', 'Local'),
      '.renart/workflows/lint-mr.yml': wf('lint-mr', 'merge_request', 'Lint'),
    } },
  })
  const { workflows, errors } = await workflowStore(reader, 'renart/workflows').list('team/app', reader, 'merge_request')
  assert.deepEqual(workflows.map((w) => [w.id, w.label]), [['summarize-mr', 'summarize-mr'], ['lint-mr', 'Lint']])
  assert.deepEqual(workflows[1].source, { project: 'team/app', path: '.renart/workflows/lint-mr.yml', sha: 'b' })
  assert.match(errors[0].message, /cannot be replaced/)
})

test('skips invalid files and reports why', async () => {
  const { reader } = fakeRepo({
    'renart/workflows': { sha: 'a', files: { 'bad.yaml': 'id: Bad\nlabel: x\ncontext: nope\ntools: [rm_rf]\nprompt: x\n', 'broken.yaml': 'id: [', 'ok.yaml': wf('ok', 'issue'), '.gitlab-ci.yml': 'validate:\n  script: [x]\n' } },
  })
  const { workflows, errors } = await workflowStore(reader, 'renart/workflows').list('missing/repo', reader)
  assert.deepEqual(workflows.map((w) => w.id), ['ok'])
  assert.deepEqual(errors.map((e) => e.path).sort(), ['bad.yaml', 'broken.yaml'])
})

test('re-reads files only when the head SHA changes', async () => {
  const { reader, reads, repos } = fakeRepo({ 'renart/workflows': { sha: 'a', files: { 'ok.yaml': wf('ok', 'issue') } } })
  const store = workflowStore(reader, 'renart/workflows')
  await store.list('x/y', reader)
  await store.list('x/y', reader)
  assert.equal(reads.length, 1)
  repos['renart/workflows'] = { sha: 'b', files: { 'ok.yaml': wf('ok', 'issue', 'New') } }
  const { workflows } = await store.list('x/y', reader)
  assert.equal(reads.length, 2)
  assert.equal(workflows[0].label, 'New')
})

test('create_merge_request is only valid with workspace: true', async () => {
  const mrWf = (extra: string) => `id: to-mr\nlabel: x\ncontext: issue\ntools: [get_issue, create_merge_request]\nprompt: x\n${extra}`
  const { reader } = fakeRepo({ 'renart/workflows': { sha: 'a', files: { 'no.yaml': mrWf(''), 'off.yaml': mrWf('workspace: false\n'), 'yes.yaml': mrWf('workspace: true\n') } } })
  const { workflows, errors } = await workflowStore(reader, 'renart/workflows').list('x/y', reader)
  assert.deepEqual(workflows.map((w) => w.source.path), ['yes.yaml'])
  assert.deepEqual(errors.map((e) => e.path).sort(), ['no.yaml', 'off.yaml'])
})

test("a caller without access to the repo gets the instance workflows only", async () => {
  const { reader } = fakeRepo({
    'renart/workflows': { sha: 'a', files: { 'plan.yaml': wf('plan', 'issue') } },
    'secret/app': { sha: 'b', files: { '.renart/workflows/leak.yaml': wf('leak', 'issue') } },
  })
  const store = workflowStore(reader, 'renart/workflows')
  await store.list('secret/app', reader) // warms the cache with an authorised caller
  const outsider: RepoReader = { ...reader, headSha: async (p) => (p === 'secret/app' ? null : reader.headSha(p)) }
  assert.deepEqual((await store.list('secret/app', outsider)).workflows.map((w) => w.id), ['plan'])
})
