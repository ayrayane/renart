import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { fetch } from 'undici'
import { KubeConfig, BatchV1Api, CoreV1Api, RequestContext, HttpMethod, type V1Job } from '@kubernetes/client-node'
import type { Workflow } from './workflows.ts'
import type { Caller } from './gitlab.ts'

export interface RunRequest {
  project: string
  mr_iid?: number
  issue_iid?: number
  pipeline_id?: number
  // Set by the orchestrator for a pipeline run, never by the client: the branch the pipeline ran on, which the fix targets.
  branch?: string
  instruction?: string
}

export interface RunConfig {
  namespace: string
  image: string
  gitlabUrl: string
  // Secret holding ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, loaded whole into the runner.
  anthropicSecret: string
  // Secret with GITLAB_TOKEN of the Renart bot account: the runner writes to GitLab as Renart, never with the user's token.
  botSecret: string
  // Optional ConfigMap with a ca.crt for a self-signed GitLab.
  caConfigMap?: string
  // Optional image pull secret for the runner image.
  pullSecret?: string
  // Engine settings passed through to every runner (RENART_ENGINE, OPENAI_BASE_URL, MODEL…).
  runnerEnv?: { name: string; value: string }[]
  // Code graph build Jobs: the orchestrator image (it carries git and CodeGraph) and their memory limit.
  graphImage?: string
  graphMemory?: string
}

export interface GraphBuild { name: string; project: string; ref: string; sha: string; uploadUrl: string; uploadToken: string }

// Pure: the Job that builds one code graph snapshot and uploads it. Its own memory, the bot token, nothing else.
export function buildGraphJob(cfg: RunConfig, b: GraphBuild): V1Job {
  const labels = { 'app.kubernetes.io/part-of': 'renart', 'renart.dev/graph-build': b.name }
  return {
    metadata: { name: b.name, labels, annotations: { 'renart.dev/project': b.project, 'renart.dev/sha': b.sha } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 1800,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          ...(cfg.pullSecret ? { imagePullSecrets: [{ name: cfg.pullSecret }] } : {}),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'build',
            image: cfg.graphImage ?? cfg.image,
            command: ['node', 'src/graph-builder.ts'],
            env: [
              { name: 'PROJECT', value: b.project },
              { name: 'REF', value: b.ref },
              { name: 'SHA', value: b.sha },
              { name: 'GITLAB_URL', value: cfg.gitlabUrl },
              { name: 'GITLAB_TOKEN', valueFrom: { secretKeyRef: { name: cfg.botSecret, key: 'GITLAB_TOKEN' } } },
              { name: 'UPLOAD_URL', value: b.uploadUrl },
              { name: 'UPLOAD_TOKEN', value: b.uploadToken },
              { name: 'WORK_DIR', value: '/work/snapshot' },
              { name: 'HOME', value: '/tmp' },
              ...(cfg.caConfigMap ? [{ name: 'NODE_EXTRA_CA_CERTS', value: '/etc/renart/ca/ca.crt' }] : []),
            ],
            resources: { requests: { cpu: '500m', memory: '512Mi' }, limits: { memory: cfg.graphMemory ?? '4Gi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [
              { name: 'work', mountPath: '/work' },
              { name: 'tmp', mountPath: '/tmp' },
              ...(cfg.caConfigMap ? [{ name: 'ca', mountPath: '/etc/renart/ca', readOnly: true }] : []),
            ],
          }],
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
            ...(cfg.caConfigMap ? [{ name: 'ca', configMap: { name: cfg.caConfigMap } }] : []),
          ],
        },
      },
    },
  }
}

// Pure: what the Job looks like. Kept apart from the API calls so it can be tested.
export interface RunGraph { url: string; token: string; ref: string; sha: string }

export const newRunId = () => `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

export function buildRun(cfg: RunConfig, wf: Workflow, req: RunRequest, caller: Caller, graph?: RunGraph, id = newRunId()) {
  const user = caller.username
  const labels = { 'app.kubernetes.io/part-of': 'renart', 'renart.dev/run': id, 'renart.dev/workflow': wf.id }
  // Audit trail on the Job itself: who ran which workflow, at which SHA, on what.
  const annotations = {
    'renart.dev/user': user,
    'renart.dev/user-id': String(caller.id),
    'renart.dev/project': req.project,
    'renart.dev/workflow-source': `${wf.source.project}/${wf.source.path}@${wf.source.sha}`,
    // The code graph this run may query: which commit, fetched through which ref.
    ...(graph ? { 'renart.dev/graph-ref': graph.ref, 'renart.dev/graph-sha': graph.sha } : {}),
  }
  const ctx = { project: req.project, mr_iid: req.mr_iid, issue_iid: req.issue_iid, pipeline_id: req.pipeline_id, branch: req.branch, instruction: req.instruction }

  const job: V1Job = {
    metadata: { name: id, labels, annotations },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          ...(cfg.pullSecret ? { imagePullSecrets: [{ name: cfg.pullSecret }] } : {}),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'runner',
            image: cfg.image,
            env: [
              { name: 'RENART_WORKFLOW', value: JSON.stringify({ id: wf.id, tools: wf.tools, prompt: wf.prompt, workspace: wf.workspace }) },
              { name: 'RENART_CONTEXT', value: JSON.stringify(ctx) },
              { name: 'RENART_RUN_ID', value: id },
              { name: 'GITLAB_URL', value: cfg.gitlabUrl },
              { name: 'GITLAB_TOKEN', valueFrom: { secretKeyRef: { name: cfg.botSecret, key: 'GITLAB_TOKEN' } } },
              // Who asked: signed on everything Renart writes, and the commit author.
              { name: 'RENART_LAUNCHED_BY', value: JSON.stringify({ username: caller.username, name: caller.name, email: caller.email }) },
              { name: 'HOME', value: '/home/runner' },
              ...(cfg.runnerEnv ?? []),
              ...(graph ? [{ name: 'RENART_GRAPH_URL', value: graph.url }, { name: 'RENART_GRAPH_TOKEN', value: graph.token }] : []),
              ...(cfg.caConfigMap ? [{ name: 'NODE_EXTRA_CA_CERTS', value: '/etc/renart/ca/ca.crt' }] : []),
            ],
            envFrom: [{ secretRef: { name: cfg.anthropicSecret, optional: true } }],
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi', 'ephemeral-storage': '7Gi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [
              { name: 'home', mountPath: '/home/runner' },
              { name: 'tmp', mountPath: '/tmp' },
              ...(cfg.caConfigMap ? [{ name: 'ca', mountPath: '/etc/renart/ca', readOnly: true }] : []),
            ],
          }],
          volumes: [
            // Bounded: a huge clone fills its own volume, not the node's disk.
            { name: 'home', emptyDir: { sizeLimit: '5Gi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } },
            ...(cfg.caConfigMap ? [{ name: 'ca', configMap: { name: cfg.caConfigMap } }] : []),
          ],
        },
      },
    },
  }
  return { id, job }
}

// A reopened pod log starts from the beginning again: each attempt hands on only what the previous ones had not.
export function resumableLog(onText: (chunk: string) => void) {
  let delivered = 0
  return {
    attempt() {
      let seen = 0
      return (chunk: string) => {
        const start = Math.max(0, delivered - seen)
        seen += chunk.length
        if (start < chunk.length) {
          delivered += chunk.length - start
          onText(chunk.slice(start))
        }
      }
    },
  }
}

export function runStore(cfg: RunConfig) {
  const kc = new KubeConfig()
  kc.loadFromDefault()
  const batch = kc.makeApiClient(BatchV1Api)
  const core = kc.makeApiClient(CoreV1Api)

  // Not client-node's Log: it pipes the response without an error handler, so a client hanging up mid-stream
  // (abort) crashed the whole process. Same request and credentials, read here with the abort handled.
  async function streamLog(pod: string, onText: (chunk: string) => void, signal: AbortSignal) {
    const url = `${kc.getCurrentCluster()!.server}/api/v1/namespaces/${namespace}/pods/${pod}/log?container=runner&follow=true`
    const ctx = new RequestContext(url, HttpMethod.GET)
    await kc.applySecurityAuthentication(ctx)
    try {
      const res = await fetch(url, { headers: ctx.getHeaders(), dispatcher: ctx.getDispatcher(), signal })
      if (!res.ok || !res.body) throw new Error(`pod log ${res.status}`)
      const decoder = new TextDecoder()
      for await (const chunk of res.body) onText(decoder.decode(chunk as Uint8Array, { stream: true }))
    } catch (e) {
      if (!signal.aborted) throw e
    }
  }
  const namespace = cfg.namespace

  return {
    async create(wf: Workflow, req: RunRequest, caller: Caller, graph?: (id: string) => RunGraph) {
      const id = newRunId()
      const { job } = buildRun(cfg, wf, req, caller, graph?.(id), id)
      await batch.createNamespacedJob({ namespace, body: job })
      return id
    },
    async get(id: string) {
      const job = await batch.readNamespacedJob({ name: id, namespace }).catch((e: { code?: number }) => {
        if (e.code === 404) return null
        throw e
      })
      if (!job) return null
      const s = job.status ?? {}
      const status = s.succeeded ? 'succeeded' : s.failed ? 'failed' : s.active ? 'running' : 'pending'
      const a = job.metadata?.annotations ?? {}
      return {
        id, status,
        workflow: job.metadata?.labels?.['renart.dev/workflow'],
        workflowSource: a['renart.dev/workflow-source'],
        user: a['renart.dev/user'],
        userId: a['renart.dev/user-id'],
        project: a['renart.dev/project'],
        graphRef: a['renart.dev/graph-ref'],
        graphSha: a['renart.dev/graph-sha'],
        instruction: (JSON.parse(job.spec?.template.spec?.containers[0].env?.find((e) => e.name === 'RENART_CONTEXT')?.value ?? '{}') as RunRequest).instruction,
        startTime: s.startTime, completionTime: s.completionTime,
      }
    },
    // How many runs this user has going: each one spends model budget and takes a pod from the quota.
    async activeFor(username: string) {
      const jobs = await batch.listNamespacedJob({ namespace, labelSelector: 'renart.dev/run' })
      return jobs.items.filter((j) => j.metadata?.annotations?.['renart.dev/user'] === username && !j.status?.succeeded && !j.status?.failed).length
    },
    // Every run Job still in the namespace (finished ones stay until ttlSecondsAfterFinished); not the graph builds.
    async list() {
      const jobs = await batch.listNamespacedJob({ namespace, labelSelector: 'renart.dev/run' })
      return jobs.items.map((j) => j.metadata!.name!)
    },
    async startGraphJob(b: GraphBuild) {
      await batch.createNamespacedJob({ namespace, body: buildGraphJob(cfg, b) }).catch((e: { code?: number }) => {
        if (e.code !== 409) throw e // already building: wait for the same Job
      })
    },
    async jobStatus(name: string): Promise<'running' | 'succeeded' | 'failed' | 'missing'> {
      const job = await batch.readNamespacedJob({ name, namespace }).catch((e: { code?: number }) => {
        if (e.code === 404) return null
        throw e
      })
      if (!job) return 'missing'
      return job.status?.succeeded ? 'succeeded' : job.status?.failed ? 'failed' : 'running'
    },
    async stop(id: string) {
      // Foreground: the pod is killed now.
      await batch.deleteNamespacedJob({ name: id, namespace, propagationPolicy: 'Foreground' })
    },
    // Streams the runner's stdout (one JSON event per line) to `onText`. While the pod is not started yet,
    // reports why (pulling, missing secret…) through `onWaiting`. Resolves when the log ends or `signal` aborts.
    async follow(id: string, onText: (chunk: string) => void, onWaiting: (reason: string) => void, signal: AbortSignal) {
      let last = ''
      const resume = resumableLog(onText)
      while (!signal.aborted) {
        const pod = (await core.listNamespacedPod({ namespace, labelSelector: `renart.dev/run=${id}` })).items[0]
        const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting
        if (pod && pod.status?.phase !== 'Pending') {
          try {
            return await streamLog(pod.metadata!.name!, resume.attempt(), signal)
          } catch (e) {
            // A run waiting minutes on a slow model writes nothing; the API server's stream idles out. Reopen it.
            const err = e as { message?: string; cause?: { code?: string; message?: string } }
            if (!/timeout/i.test(`${err.message} ${err.cause?.code} ${err.cause?.message}`)) throw e
            continue
          }
        }
        if (!pod) {
          // A Job that ended without a pod (deadline, deleted pod) has no log to wait for.
          const s = (await batch.readNamespacedJob({ name: id, namespace }).catch(() => null))?.status
          if (!s || s.succeeded || s.failed) return
        }
        const reason = waiting ? `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}` : pod ? 'Pending' : 'Scheduling'
        if (reason !== last) onWaiting((last = reason))
        await sleep(1000, undefined, { signal }).catch(() => {})
      }
    },
  }
}
