import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseContext, parseSSE, pkce, mrConditions, gitlabBase } from '../lib.js'

const gl = 'https://gitlab.example.com'

test('reads merge request, issue, pipeline, job and project pages', () => {
  assert.deepEqual(parseContext(`${gl}/g/sub/app/-/merge_requests/12/diffs`, gl), { project: 'g/sub/app', context: 'merge_request', iid: 12 })
  assert.deepEqual(parseContext(`${gl}/g/app/-/issues/3#note_1`, gl), { project: 'g/app', context: 'issue', iid: 3 })
  assert.deepEqual(parseContext(`${gl}/g/app/-/work_items/7`, gl), { project: 'g/app', context: 'issue', iid: 7 })
  assert.deepEqual(parseContext(`${gl}/g/app/-/pipelines/41`, gl), { project: 'g/app', context: 'pipeline', iid: 41 })
  assert.deepEqual(parseContext(`${gl}/g/app/-/jobs/97`, gl), { project: 'g/app', context: 'pipeline', job: 97 })
  assert.equal(parseContext(`${gl}/g/app/-/pipelines`, gl)?.context, 'project')
  assert.deepEqual(parseContext(`${gl}/g/app/-/tree/main`, gl), { project: 'g/app', context: 'project' })
  assert.deepEqual(parseContext(`${gl}/g/app`, gl), { project: 'g/app', context: 'project' })
})

test('ignores non-project pages and other hosts', () => {
  assert.equal(parseContext(`${gl}/g`, gl), null)
  assert.equal(parseContext(`${gl}/dashboard/merge_requests`, gl), null)
  assert.equal(parseContext(`${gl}/g/app/-/merge_requests`, gl)?.context, 'project')
  assert.equal(parseContext('https://evil.example.com/g/app/-/issues/1', gl), null)
})

test('handles GitLab under a sub-path', () => {
  assert.deepEqual(parseContext('https://h/gitlab/g/app/-/issues/2', 'https://h/gitlab/'), { project: 'g/app', context: 'issue', iid: 2 })
  assert.equal(parseContext('https://h/other/g/app', 'https://h/gitlab'), null)
})

test('splits SSE events and keeps the partial tail', () => {
  const { events, rest } = parseSSE('event: waiting\ndata: {"reason":"x"}\n\ndata: {"a":1}\n\ndata: {"b"')
  assert.deepEqual(events, [{ event: 'waiting', data: '{"reason":"x"}' }, { event: 'message', data: '{"a":1}' }])
  assert.equal(rest, 'data: {"b"')
})

test('pkce challenge is the S256 of the verifier', async () => {
  const { verifier, challenge } = await pkce()
  assert.match(verifier, /^[\w-]{43}$/)
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
  assert.equal(challenge, expected)
})

test('reads the SSE id used to resume a stream', () => {
  const { events } = parseSSE('id: 7\ndata: {"event":"text"}\n\nevent: end\ndata: {}\n\n')
  assert.deepEqual(events, [{ event: 'message', data: '{"event":"text"}', id: 7 }, { event: 'end', data: '{}' }])
})

test('merge request conditions that show situational actions', () => {
  const thread = (/** @type {boolean[]} */ ...resolved) => ({ notes: resolved.map((r) => ({ resolvable: true, resolved: r })) })
  assert.deepEqual(mrConditions({ source_branch: 'feat' }, null), { has_conflicts: false, unresolved_discussions: false, dependency_update: false })
  assert.equal(mrConditions({ has_conflicts: true }, null).has_conflicts, true)
  assert.equal(mrConditions({}, [thread(true, true)]).unresolved_discussions, false)
  assert.equal(mrConditions({}, [thread(true, true), thread(false)]).unresolved_discussions, true)
  assert.equal(mrConditions({}, [{ notes: [{ resolvable: false }] }]).unresolved_discussions, false)
  assert.equal(mrConditions({ source_branch: 'renovate/lodash-4.x' }, null).dependency_update, true)
  assert.equal(mrConditions({ source_branch: 'dependabot/npm_and_yarn/x' }, null).dependency_update, true)
  assert.equal(mrConditions({ source_branch: 'x', labels: ['Dependencies'] }, null).dependency_update, true)
  assert.equal(mrConditions({ source_branch: 'renovation' }, null).dependency_update, false)
})

test('a pasted GitLab page URL is cut back to the GitLab address', () => {
  assert.equal(gitlabBase('https://gitlab.example.com/g/app/-/merge_requests/6'), 'https://gitlab.example.com')
  assert.equal(gitlabBase('https://h/gitlab/'), 'https://h/gitlab')
  assert.equal(gitlabBase('pas une url'), 'pas une url')
})
