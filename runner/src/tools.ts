import { z } from 'zod'
import { tool, createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { Workspace } from './workspace.ts'

// The GitLab tools. Each is bound to the run's project: the model never picks which project it touches.
export type GitLabCall = (method: string, path: string, body?: unknown) => Promise<unknown>

export function gitlabCall(baseUrl: string, token: string, project: string): GitLabCall {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(project)}`
  return async (method, path, body) => {
    const res = await fetch(api + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`GitLab ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`)
    // Job logs come back as plain text.
    return text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null
  }
}

const iid = z.number().int().positive()

// GitLab runs quick actions (/merge, /approve, /close…) found at the start of a line in notes and MR descriptions,
// even through the API. Whatever the model writes goes through this: a zero-width space keeps the text, kills the action.
export const noQuickActions = (text: string) => text.replace(/^(\s*)\//gm, '$1\u200B/')

export interface LaunchedBy { username: string; name: string; email: string }

// Everything Renart writes says who asked for it (the username in code, so it does not ping them).
// The model sometimes copies a signature it saw in earlier comments: drop any, so the only one is ours and true.
const SIGNATURE = /^[ \t]*_?Lancé par .* via Renart_?[ \t]*$/gim
export function signed(text: string, by?: LaunchedBy) {
  const body = noQuickActions(text.replace(SIGNATURE, '').replace(/(\n\s*-{3,}\s*)+$/, '').trimEnd())
  return by ? `${body}\n\n---\n_Lancé par ${by.name.replace(/[*_`[\]<>]/g, '')} (\`@${by.username}\`) via Renart_` : body
}
const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] })

// Job logs without colours and GitLab's collapsible-section markers, last `lines` lines only.
export function tail(log: string, lines: number) {
  const clean = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/section_(start|end):\d+:[\w.-]+\r?/g, '').replace(/\r(?!\n)/g, '\n')
  return clean.split('\n').slice(-lines).join('\n')
}

// The open merge request a pipeline belongs to: from a merge request pipeline's ref, or by its branch.
async function pipelineMr(call: GitLabCall, ref: string): Promise<number | null> {
  const m = ref.match(/^refs\/merge-requests\/(\d+)\//)
  if (m) return Number(m[1])
  const mrs = await call('GET', `/merge_requests?state=opened&source_branch=${encodeURIComponent(ref)}`) as { iid: number }[]
  return mrs[0]?.iid ?? null
}

// What a run may touch: its own merge request, issue or pipeline (with that pipeline's MR and jobs, or that MR's pipelines).
// Text the agent reads (an MR, an issue, a CI log) cannot point the bot at another MR, a confidential issue or other jobs.
export interface Scope { mr_iid?: number; issue_iid?: number; pipeline_id?: number }

function guard(call: GitLabCall, scope: Scope) {
  const deny = (what: string): never => { throw new Error(`${what} is outside this run: only its own merge request, issue or pipeline can be used`) }
  const mrOfPipeline = async (id: number) => pipelineMr(call, ((await call('GET', `/pipelines/${id}`)) as { ref: string }).ref)
  let own: Promise<number | null> | undefined
  const ownMr = () => (own ??= scope.mr_iid ? Promise.resolve(scope.mr_iid) : scope.pipeline_id ? mrOfPipeline(scope.pipeline_id) : Promise.resolve(null))
  const pipeline = async (id: number) => {
    if (id !== scope.pipeline_id && (!scope.mr_iid || (await mrOfPipeline(id)) !== scope.mr_iid)) deny(`pipeline ${id}`)
  }
  return {
    mr: async (iid: number) => { if (iid !== (await ownMr())) deny(`merge request !${iid}`) },
    issue: (iid: number) => { if (iid !== scope.issue_iid) deny(`issue #${iid}`) },
    pipeline,
    job: async (id: number) => pipeline(((await call('GET', `/jobs/${id}`)) as { pipeline: { id: number } }).pipeline.id),
  }
}

// What the bot writes loads no outside image (it would leak the reader's address, or data in its URL), pings no one
// en masse and closes no issue but the run's own. shortcut: group mentions are not known here, protect groups with GitLab settings.
export function sanitize(text: string, scope: Scope = {}) {
  return text
    .replace(/!\[([^\]]*)\]\(\s*(?:https?:)?\/\/[^)]*\)/g, '$1')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/@(all|here)\b/gi, '@\u200B$1')
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?)(:?\s+)#(\d+)\b/gi,
      (m, verb: string, sp: string, n: string) => (Number(n) === scope.issue_iid ? m : `${verb}\u200B${sp}#${n}`))
}

export interface MrTarget {
  workspace: Pick<Workspace, 'baseBranch' | 'commitAndPush' | 'mergeFrom'>
  branch: string
  author: { name: string; email: string }
}

export function gitlabTools(call: GitLabCall, mr?: MrTarget, by?: LaunchedBy, scope: Scope = {}) {
  const g = guard(call, scope)
  const write = (text: string) => signed(sanitize(text, scope), by)
  return {
    get_merge_request: tool('get_merge_request', 'Read a merge request: title, description, branches, diff refs (base/head/start SHA), the file diffs and the comments.',
      { iid }, async ({ iid }) => {
        await g.mr(iid)
        const [mr, changes, notes] = await Promise.all([
          call('GET', `/merge_requests/${iid}`),
          call('GET', `/merge_requests/${iid}/diffs?per_page=100`),
          call('GET', `/merge_requests/${iid}/notes?per_page=100&sort=asc`),
        ])
        // System notes ("added 1 commit", label changes…) are noise for the model.
        return ok({ mr, changes, notes: (notes as { system: boolean }[]).filter((n) => !n.system) })
      }),
    get_discussions: tool('get_discussions', 'The unresolved review threads of a merge request: thread id, file and line, and every note with its author. Resolved threads are only counted.',
      { iid }, async ({ iid }) => {
        await g.mr(iid)
        type Note = { body: string; system: boolean; resolvable: boolean; resolved?: boolean; author: { username: string }; position?: { new_path?: string; new_line?: number; old_path?: string; old_line?: number } }
        const all = await call('GET', `/merge_requests/${iid}/discussions?per_page=100`) as { id: string; notes: Note[] }[]
        const threads = all.filter((d) => d.notes[0]?.resolvable && !d.notes[0].system)
        const open = threads.filter((d) => !d.notes.every((n) => n.resolved))
        return ok({
          resolved_count: threads.length - open.length,
          unresolved: open.map((d) => {
            const p = d.notes[0].position
            return { discussion_id: d.id, file: p?.new_path ?? p?.old_path, line: p?.new_line ?? p?.old_line, notes: d.notes.map((n) => ({ author: n.author.username, body: n.body })) }
          }),
        })
      }),
    reply_to_discussion: tool('reply_to_discussion', 'Reply in a review thread of a merge request (it stays unresolved: the reviewer resolves it).',
      { iid, discussion_id: z.string().min(1), body: z.string().min(1) },
      async ({ iid, discussion_id, body }) => {
        await g.mr(iid)
        return ok(await call('POST', `/merge_requests/${iid}/discussions/${encodeURIComponent(discussion_id)}/notes`, { body: write(body) }))
      }),
    update_merge_request_description: tool('update_merge_request_description', 'Replace the description of a merge request with the given Markdown.',
      { iid, description: z.string().min(1) },
      async ({ iid, description }) => {
        await g.mr(iid)
        return ok(await call('PUT', `/merge_requests/${iid}`, { description: write(description) }))
      }),
    merge_target_branch: tool('merge_target_branch', 'Merge the target branch of a merge request into the cloned source branch, without committing. Returns the files left with conflict markers: resolve each one by editing it (keep both sides\' intent, remove every marker), then call create_merge_request.',
      { iid }, async ({ iid }) => {
        if (!mr) throw new Error('merge_target_branch needs a workflow with workspace: true')
        await g.mr(iid)
        const { target_branch } = await call('GET', `/merge_requests/${iid}`) as { target_branch: string }
        return ok({ target_branch, conflicts: await mr.workspace.mergeFrom(target_branch) })
      }),
    get_issue: tool('get_issue', 'Read an issue and its comments.',
      { iid }, async ({ iid }) => {
        g.issue(iid)
        const [issue, notes] = await Promise.all([call('GET', `/issues/${iid}`), call('GET', `/issues/${iid}/notes?per_page=100&sort=asc`)])
        return ok({ issue, notes })
      }),
    get_pipeline: tool('get_pipeline', 'Read a CI pipeline: its branch, commit and status, the merge request it belongs to (if any), every job with its status, and the end of the log of each failed job.',
      { id: iid }, async ({ id }) => {
        await g.pipeline(id)
        const [pipeline, jobs] = await Promise.all([
          call('GET', `/pipelines/${id}`) as Promise<{ ref: string; sha: string; status: string; web_url: string }>,
          call('GET', `/pipelines/${id}/jobs?per_page=100`) as Promise<{ id: number; name: string; stage: string; status: string; failure_reason?: string; allow_failure: boolean }[]>,
        ])
        const failed = jobs.filter((j) => j.status === 'failed' && !j.allow_failure).slice(0, 5)
        const logs = await Promise.all(failed.map(async (j) => ({ job: j.name, id: j.id, log_end: tail(String(await call('GET', `/jobs/${j.id}/trace`) ?? ''), 150) })))
        return ok({
          pipeline: { id, ref: pipeline.ref, sha: pipeline.sha, status: pipeline.status, web_url: pipeline.web_url },
          merge_request_iid: await pipelineMr(call, pipeline.ref),
          jobs: jobs.map(({ id, name, stage, status, failure_reason, allow_failure }) => ({ id, name, stage, status, failure_reason, allow_failure })),
          failed_logs: logs,
        })
      }),
    get_job_log: tool('get_job_log', 'The end of the log of one CI job (up to the last 1000 lines), for a failure get_pipeline did not show enough of.',
      { job_id: iid }, async ({ job_id }) => {
        await g.job(job_id)
        return { content: [{ type: 'text' as const, text: tail(String(await call('GET', `/jobs/${job_id}/trace`) ?? ''), 1000) }] }
      }),
    comment_merge_request: tool('comment_merge_request', 'Post a Markdown comment on a merge request.',
      { iid, body: z.string().min(1) }, async ({ iid, body }) => {
        await g.mr(iid)
        return ok(await call('POST', `/merge_requests/${iid}/notes`, { body: write(body) }))
      }),
    comment_diff_line: tool('comment_diff_line', 'Comment on one line of a merge request diff. SHAs come from get_merge_request diff_refs; set new_line for added/unchanged lines, old_line for removed ones.',
      {
        iid, body: z.string().min(1), base_sha: z.string(), head_sha: z.string(), start_sha: z.string(),
        old_path: z.string(), new_path: z.string(), new_line: z.number().int().optional(), old_line: z.number().int().optional(),
      },
      async ({ iid, body, ...p }) => {
        await g.mr(iid)
        return ok(await call('POST', `/merge_requests/${iid}/discussions`, { body: write(body), position: { position_type: 'text', ...p } }))
      }),
    comment_issue: tool('comment_issue', 'Post a Markdown comment on an issue.',
      { iid, body: z.string().min(1) }, async ({ iid, body }) => {
        g.issue(iid)
        return ok(await call('POST', `/issues/${iid}/notes`, { body: write(body) }))
      }),
    create_merge_request: tool('create_merge_request', 'Commit every file change made in the repository workspace to a new branch and open a draft merge request for it. Call it once, when the changes are done.',
      { title: z.string().min(1), description: z.string() },
      async ({ title, description }) => {
        if (!mr) throw new Error('create_merge_request needs a workflow with workspace: true')
        const clean = title.replace(/^draft:\s*/i, '')
        // The runner commits and pushes, not the model: no shell, and never the default branch.
        await mr.workspace.commitAndPush(mr.branch, clean, mr.author)
        return ok(await call('POST', '/merge_requests', {
          source_branch: mr.branch, target_branch: mr.workspace.baseBranch, remove_source_branch: true,
          // Always draft: a human decides when it is ready.
          // The bot's push skips CI (it would run with the bot's rights): a person starts the pipeline from the MR.
          title: `Draft: ${clean}`, description: write(`${description}\n\n> Pipeline non lancée automatiquement : lancez-la depuis cette MR après relecture.`),
        }))
      }),
  }
}

export type ToolName = keyof ReturnType<typeof gitlabTools>

// The code graph of the repository at this run's commit, served by the orchestrator.
export type GraphCall = (tool: string, args: Record<string, string | string[]>) => Promise<string>

export function graphCall(url: string, run: string, token: string): GraphCall {
  return async (tool, args) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run, token, tool, args }) })
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
    if (!res.ok) throw new Error(`code graph: ${body.error ?? res.status}`)
    return body.text ?? ''
  }
}

export function graphTools(graph: GraphCall) {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  const name = z.string().min(1).max(300)
  return {
    code_graph_explore: tool('code_graph_explore', 'Explore an area of the repository from the code graph: the relevant symbols with their source, the call paths between them and a blast-radius summary (what depends on them, which tests cover them). Start here to understand code you have not seen.',
      { question: name }, async ({ question }) => text(await graph('code_graph_explore', { question }))),
    code_graph_callers: tool('code_graph_callers', 'Every function or method that calls a symbol, with file:line. Use it before changing or judging a change to that symbol.',
      { symbol: name }, async ({ symbol }) => text(await graph('code_graph_callers', { symbol }))),
    code_graph_impact: tool('code_graph_impact', 'What is affected by changing a symbol: the symbols and files that depend on it, two levels deep, with file:line.',
      { symbol: name }, async ({ symbol }) => text(await graph('code_graph_impact', { symbol }))),
    code_graph_affected: tool('code_graph_affected', 'The test files affected by a set of changed source files (paths relative to the repository root).',
      { files: z.array(name).min(1).max(50) }, async ({ files }) => text(await graph('code_graph_affected', { files }))),
  }
}

// The workflow's tools, checked; both engines start from this list.
export function pickTools(call: GitLabCall, allowed: string[], mr?: MrTarget, by?: LaunchedBy, graph?: GraphCall, scope: Scope = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Record<string, SdkMcpToolDefinition<any>> = { ...gitlabTools(call, mr, by, scope), ...(graph ? graphTools(graph) : {}) }
  const unknown = allowed.filter((t) => !(t in all))
  if (unknown.length) throw new Error(`unknown tools in workflow: ${unknown.join(', ')}`)
  for (const t of ['create_merge_request', 'merge_target_branch']) if (allowed.includes(t) && !mr) throw new Error(`${t} needs a workflow with workspace: true`)
  return allowed.map((t) => all[t]!)
}

export function gitlabServer(call: GitLabCall, allowed: string[], mr?: MrTarget, by?: LaunchedBy, graph?: GraphCall, scope: Scope = {}) {
  return {
    server: createSdkMcpServer({ name: 'gitlab', tools: pickTools(call, allowed, mr, by, graph, scope) }),
    allowedTools: allowed.map((t) => `mcp__gitlab__${t}`),
  }
}
