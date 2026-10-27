import { createServer } from 'node:http'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { gitlab, mrBranch, pipelineBranch, projectAccess } from './gitlab.ts'
import { workflowStore, type Context } from './workflows.ts'
import { auditLog, summarize, type AuditRecord } from './audit.ts'
import { graphStore, runToken, validToken, uploadToken, validUpload, GRAPH_TOOLS } from './graph.ts'
import { runStore, type RunRequest } from './runs.ts'

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const gitlabUrl = env('GITLAB_URL')
// The bot's token is only used here to check Renart can reach a project; the runner gets it from the Secret.
const botToken = env('BOT_GITLAB_TOKEN')
// Signs run and upload tokens. Its own random secret (the chart creates one); the bot token is only a fallback.
const hmacKey = process.env.HMAC_KEY || botToken
const MAX_RUNS_PER_USER = Number(env('MAX_RUNS_PER_USER', '3'))
const DEVELOPER = 30
const store = workflowStore(gitlab(gitlabUrl, env('GITLAB_TOKEN')), env('WORKFLOWS_PROJECT', 'renart/workflows'))
const runs = runStore({
  namespace: env('RUNS_NAMESPACE', 'renart'),
  image: env('RUNNER_IMAGE'),
  gitlabUrl,
  anthropicSecret: env('ANTHROPIC_SECRET', 'renart-anthropic'),
  botSecret: env('BOT_SECRET', 'renart-bot'),
  caConfigMap: process.env.RUNNER_CA_CONFIGMAP,
  pullSecret: process.env.RUNNER_PULL_SECRET,
  // The engine is chosen at install time and handed to every run.
  runnerEnv: ['RENART_ENGINE', 'OPENAI_BASE_URL', 'MODEL', 'RENART_MODEL']
    .filter((name) => process.env[name])
    .map((name) => ({ name, value: process.env[name]! })),
  graphImage: process.env.GRAPH_IMAGE,
  graphMemory: process.env.GRAPH_MEMORY,
})
const app = Fastify({ logger: true })
// /internal answers only on the internal port; the public one (behind the Ingress) says it does not exist.
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/internal/') !== (req.socket.localPort === internalPort)) return reply.code(404).send({ error: 'not found' })
})

// Code graph: built here, queried by runs through /internal/graph.
// Runs and graph builds call the /internal routes on their own port, which the Ingress never routes to.
const internalPort = Number(env('INTERNAL_PORT', '8081'))
const internalUrl = env('INTERNAL_URL', `http://localhost:${internalPort}`)
// Builds run as their own Jobs (their own memory) and upload the snapshot back to /internal/graph-snapshot.
const graphs = graphStore({
  dir: env('GRAPH_DIR', '/tmp/graphs'),
  codegraph: process.env.CODEGRAPH_BIN,
  jobs: {
    start: (name, t) => runs.startGraphJob({
      name, ...t,
      uploadUrl: `${internalUrl}/internal/graph-snapshot?${new URLSearchParams({ project: t.project, sha: t.sha })}`,
      uploadToken: uploadToken(hmacKey, t.project, t.sha),
    }),
    status: (name) => runs.jobStatus(name),
  },
})

// GitLab REST read on a project with the bot's token.
async function botGet(project: string, path: string) {
  const res = await fetch(`${gitlabUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(project)}${path}`, { headers: { Authorization: `Bearer ${botToken}` } })
  if (!res.ok) throw new Error(`GitLab ${res.status} on ${path || 'project'}`)
  return res.json() as Promise<Record<string, any>>
}

// The commit a run's graph describes: the merge request head, the branch a pipeline fix targets, or the default branch.
async function graphTarget(project: string, req: RunRequest): Promise<{ ref: string; sha: string }> {
  const get = (path: string) => botGet(project, path)
  if (req.mr_iid) return { ref: `refs/merge-requests/${req.mr_iid}/head`, sha: (await get(`/merge_requests/${req.mr_iid}`)).sha }
  const branch = req.branch ?? (await get('')).default_branch as string
  return { ref: `refs/heads/${branch}`, sha: (await get(`/repository/branches/${encodeURIComponent(branch)}`)).commit.id }
}
const audit = auditLog(process.env.AUDIT_FILE)
// No new runs while the audit cannot be written: every run must leave a record.
let auditDown = false

// Follows a run to its end, watched or not, and writes one audit record. Everything it needs is on the Job,
// so it works the same for a run just created and for one found running after a restart.
async function record(id: string) {
  const lines: string[] = []
  let partial = ''
  await runs.follow(id, (chunk) => {
    const parts = (partial + chunk).split('\n')
    partial = parts.pop()!
    lines.push(...parts)
  }, () => {}, AbortSignal.timeout(30 * 60_000))
  let final = await runs.get(id)
  for (let i = 0; i < 15 && (final?.status === 'running' || final?.status === 'pending'); i++) {
    await sleep(2000)
    final = await runs.get(id)
  }
  if (!final) return // deleted (stopped) before we could read it
  const started = final.startTime ? new Date(final.startTime).getTime() : Date.now()
  const end = final.completionTime ? new Date(final.completionTime).getTime() : Date.now()
  const rec: AuditRecord = {
    at: new Date().toISOString(), id, user: final.user ?? '', project: final.project ?? '', workflow: final.workflow ?? '',
    workflowSource: final.workflowSource ?? '', instruction: final.instruction,
    status: final.status, durationMs: end - started, ...summarize(lines),
  }
  app.log.info({ audit: rec }, 'run finished')
  await audit.append(rec).then(() => { auditDown = false }, (e) => { auditDown = true; throw e })
}

const bearer = (req: FastifyRequest) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]

// Which iid each context needs, so a run never starts with a half-filled prompt.
const required: Record<Context, keyof RunRequest | null> = { merge_request: 'mr_iid', issue: 'issue_iid', pipeline: 'pipeline_id', project: null }

app.get<{ Querystring: { project: string; context?: Context } }>('/workflows', {
  schema: {
    querystring: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', minLength: 1 },
        context: { enum: ['merge_request', 'issue', 'pipeline', 'project'] },
      },
    },
  },
}, async (req, reply) => {
  const token = bearer(req)
  if (!token) return reply.code(401).send({ error: 'missing Bearer token' })
  // Both at once; the list is only returned once access is confirmed.
  const [access, result] = await Promise.all([
    projectAccess(gitlabUrl, token, req.query.project),
    store.list(req.query.project, gitlab(gitlabUrl, token), req.query.context).catch(() => null),
  ])
  if (!access) return reply.code(403).send({ error: 'token cannot access this project' })
  if (!result) return reply.code(502).send({ error: 'cannot read the workflows' })
  for (const e of result.errors) req.log.warn(e, 'invalid workflow skipped')
  return result
})

app.post<{ Body: RunRequest & { workflow: string } }>('/runs', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['workflow', 'project'],
      properties: {
        workflow: { type: 'string', minLength: 1 },
        project: { type: 'string', minLength: 1 },
        mr_iid: { type: 'integer', minimum: 1 },
        issue_iid: { type: 'integer', minimum: 1 },
        pipeline_id: { type: 'integer', minimum: 1 },
        instruction: { type: 'string', maxLength: 4000 },
      },
    },
  },
}, async (req, reply) => {
  const token = bearer(req)
  if (!token) return reply.code(401).send({ error: 'missing Bearer token' })
  const { workflow: workflowId, ...run } = req.body
  if (auditDown) return reply.code(503).send({ error: 'audit log unavailable, runs are paused' })
  const [user, bot, listed] = await Promise.all([
    projectAccess(gitlabUrl, token, run.project),
    projectAccess(gitlabUrl, botToken, run.project),
    store.list(run.project, gitlab(gitlabUrl, token)).catch(() => null),
  ])
  if (!user) return reply.code(403).send({ error: 'token cannot access this project' })
  // Renart writes with its own account, so the caller must be allowed to write there themselves.
  if (user.accessLevel < DEVELOPER) return reply.code(403).send({ error: 'Developer role required on this project' })
  if (!bot) return reply.code(409).send({ error: 'the Renart account is not a member of this project' })
  if ((await runs.activeFor(user.username)) >= MAX_RUNS_PER_USER) return reply.code(429).send({ error: `too many runs in progress (max ${MAX_RUNS_PER_USER})` })

  const wf = listed?.workflows.find((w) => w.id === workflowId)
  if (!wf) return reply.code(404).send({ error: `no workflow ${workflowId} for ${run.project}` })
  const need = required[wf.context]
  if (need && run[need] === undefined) return reply.code(400).send({ error: `workflow ${wf.id} needs ${need}` })
  // Repository work on a pipeline or a merge request goes on its branch, through a draft MR targeting it.
  if (wf.context === 'pipeline' || (wf.context === 'merge_request' && wf.workspace)) {
    try {
      const get = (path: string) => botGet(run.project, path)
      run.branch = wf.context === 'pipeline' ? await pipelineBranch(get, run.pipeline_id!) : await mrBranch(get, run.mr_iid!)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
  }

  // Workflows that query the code graph get it built now, while the runner pod starts.
  let graph: Awaited<ReturnType<typeof graphTarget>> | undefined
  if (wf.tools.some((t) => GRAPH_TOOLS.includes(t))) {
    graph = await graphTarget(run.project, run)
    graphs.ensure(run.project, graph.ref, graph.sha).catch((e) => app.log.error(e, 'graph build failed'))
  }
  const id = await runs.create(wf, run, user, graph && ((runId) => ({ ...graph!, url: `${internalUrl}/internal/graph`, token: runToken(hmacKey, runId) })))
  req.log.info({ id, user: user.username, workflow: wf.id, project: run.project }, 'run created')
  record(id).catch((e) => app.log.error(e, 'audit record failed'))
  return reply.code(201).send({ id })
})

// The run, if the caller is the user who launched it; otherwise replies 401/404 and returns null.
async function ownRun(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const token = bearer(req)
  if (!token) {
    reply.code(401).send({ error: 'missing Bearer token' })
    return null
  }
  const run = await runs.get(req.params.id)
  // Same answer for "no such run" and "not yours", so run ids cannot be probed.
  const caller = run?.project ? await projectAccess(gitlabUrl, token, run.project) : null
  // By numeric id; runs from before the id annotation fall back to the username.
  if (!run?.project || !caller || (run.userId ? String(caller.id) !== run.userId : caller.username !== run.user)) {
    reply.code(404).send({ error: 'run not found' })
    return null
  }
  return run
}

app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => (await ownRun(req, reply)) ?? reply)

app.post<{ Params: { id: string } }>('/runs/:id/stop', async (req, reply) => {
  const run = await ownRun(req, reply)
  if (!run) return reply
  await runs.stop(run.id)
  req.log.info({ id: run.id, user: run.user }, 'run stopped')
  return reply.code(202).send({ id: run.id })
})

// Server-sent events: one `data:` per runner event, `event: waiting` while the pod starts, `event: end` with the final status.
// Read with fetch (EventSource cannot send the Authorization header). Runner events carry `id: <n>`; a client that lost
// the stream reconnects with ?after=<last id> and the log is replayed from the next one.
app.get<{ Params: { id: string }; Querystring: { after?: number } }>('/runs/:id/events', {
  schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 } } } },
}, async (req, reply) => {
  const run = await ownRun(req, reply)
  if (!run) return reply
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
  const send = (data: string, event?: string, id?: number) =>
    res.write(`${event ? `event: ${event}\n` : ''}${id ? `id: ${id}\n` : ''}data: ${data}\n\n`)
  const after = req.query.after ?? 0
  let seq = 0
  const abort = new AbortController()
  req.raw.on('close', () => abort.abort())

  let partial = ''
  // The runner's own verdict: the end event need not wait for the Job status to catch up.
  let verdict: 'succeeded' | 'failed' | undefined
  const onText = (chunk: string) => {
    const lines = (partial + chunk).split('\n')
    partial = lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      if (line.includes('"event":"result"')) verdict = /"subtype":"success"/.test(line) ? 'succeeded' : 'failed'
      if (++seq > after) send(line, undefined, seq)
    }
  }
  try {
    await runs.follow(run.id, onText, (reason) => send(JSON.stringify({ reason }), 'waiting'), abort.signal)
    // The Job status lags the pod by a moment; wait for it to settle before the final event.
    let final = verdict ? { status: verdict } : await runs.get(run.id)
    for (let i = 0; i < 30 && final && (final.status === 'running' || final.status === 'pending') && !abort.signal.aborted; i++) {
      await sleep(1000)
      final = await runs.get(run.id)
    }
    send(JSON.stringify({ status: final?.status ?? 'stopped' }), 'end')
  } catch (e) {
    req.log.error(e, 'event stream failed')
    send(JSON.stringify({ error: 'event stream failed' }), 'error')
  }
  res.end()
})

// Graph queries from runs. Never through the ingress: a run calls the Service directly with its own token.
app.post<{ Body: { run: string; token: string; tool: string; args: Record<string, unknown> } }>('/internal/graph', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['run', 'token', 'tool', 'args'],
      properties: { run: { type: 'string', maxLength: 64 }, token: { type: 'string', maxLength: 128 }, tool: { type: 'string', maxLength: 64 }, args: { type: 'object' } },
    },
  },
}, async (req, reply) => {
  const { run: id, token, tool, args } = req.body
  if (!validToken(hmacKey, id, token)) return reply.code(403).send({ error: 'bad run token' })
  const r = await runs.get(id)
  if (!r?.project || !r.graphRef || !r.graphSha) return reply.code(404).send({ error: 'no code graph for this run' })
  try {
    const dir = await graphs.ensure(r.project, r.graphRef, r.graphSha)
    return { text: await graphs.query(dir, tool, args) }
  } catch (e) {
    req.log.error(e, 'graph query failed')
    return reply.code(422).send({ error: (e as Error).message.slice(0, 300) })
  }
})

// Snapshot uploads from graph build Jobs: a gzipped tar, streamed straight to disk.
app.addContentTypeParser('application/gzip', (_req, payload, done) => done(null, payload))
app.post<{ Querystring: { project: string; sha: string } }>('/internal/graph-snapshot', {
  schema: {
    querystring: {
      type: 'object', required: ['project', 'sha'],
      properties: { project: { type: 'string', minLength: 1, maxLength: 255 }, sha: { type: 'string', pattern: '^[0-9a-f]{40}$' } },
    },
  },
}, async (req, reply) => {
  const { project, sha } = req.query
  const token = String(req.headers['x-renart-upload-token'] ?? '')
  if (!validUpload(hmacKey, project, sha, token)) return reply.code(403).send({ error: 'bad upload token' })
  try {
    await graphs.receive(project, sha, req.body as Readable)
    req.log.info({ project, sha }, 'code graph snapshot received')
    return reply.code(204).send()
  } catch (e) {
    req.log.error(e, 'code graph snapshot refused')
    return reply.code(422).send({ error: (e as Error).message.slice(0, 300) })
  }
})

app.get('/healthz', async () => ({ ok: true }))


await app.listen({ host: '0.0.0.0', port: Number(env('PORT', '8080')) })
createServer((req, res) => app.routing(req, res)).listen(internalPort, '0.0.0.0')

// Runs that were in flight (or finished unrecorded) while the orchestrator was down get their audit record now.
if (process.env.AUDIT_FILE) {
  const done = await audit.ids()
  const missing = (await runs.list()).filter((id) => !done.has(id))
  if (missing.length) app.log.info({ missing }, 'resuming audit of unrecorded runs')
  for (const id of missing) record(id).catch((e) => app.log.error(e, 'audit record failed'))
}
