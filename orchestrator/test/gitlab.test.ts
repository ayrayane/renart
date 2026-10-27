import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mrBranch, pipelineBranch } from '../src/gitlab.ts'

const fake = (data: Record<string, object>) => async (path: string) => {
  if (!(path in data)) throw new Error(`GitLab 404 on ${path}`)
  return data[path]
}

test('a pipeline fix targets the branch the pipeline ran on', async () => {
  assert.equal(await pipelineBranch(fake({ '/pipelines/7': { ref: 'feature/x', tag: false } }), 7), 'feature/x')
  // Merge request pipelines run on refs/merge-requests/<iid>/head: the fix goes to the MR's source branch.
  const mrPipeline = fake({
    '/pipelines/8': { ref: 'refs/merge-requests/3/head', tag: false },
    '/merge_requests/3': { source_branch: 'fix-me', source_project_id: 1, target_project_id: 1 },
  })
  assert.equal(await pipelineBranch(mrPipeline, 8), 'fix-me')
})

test('tags, forks and unknown pipelines are refused', async () => {
  await assert.rejects(pipelineBranch(fake({ '/pipelines/1': { ref: 'v1.0', tag: true } }), 1), /tag/)
  await assert.rejects(pipelineBranch(fake({
    '/pipelines/2': { ref: 'refs/merge-requests/4/merge', tag: false },
    '/merge_requests/4': { source_branch: 'x', source_project_id: 9, target_project_id: 1 },
  }), 2), /fork/)
  await assert.rejects(pipelineBranch(fake({}), 3), /404/)
})

test('work on a merge request goes on its source branch', async () => {
  assert.equal(await mrBranch(fake({ '/merge_requests/2': { source_branch: 'feat', source_project_id: 1, target_project_id: 1 } }), 2), 'feat')
})
