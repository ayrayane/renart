import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRun, resumableLog } from '../src/runs.ts'
import type { Workflow } from '../src/workflows.ts'

const wf: Workflow = {
  id: 'summarize-mr', label: 'Résumer', context: 'merge_request', tools: ['get_merge_request'], prompt: 'MR {{mr.iid}}',
  source: { project: 'renart/workflows', path: 'summarize-mr.yaml', sha: 'abc' },
}
const cfg = { namespace: 'renart', image: 'runner:1', gitlabUrl: 'https://gl', anthropicSecret: 'renart-anthropic', botSecret: 'renart-bot', caConfigMap: 'lab-ca' }
const alice = { id: 7, username: 'alice', name: 'Alice', email: 'a@x', accessLevel: 30 }

test('the runner gets the bot token and who launched the run, never a user token', () => {
  const { id, job } = buildRun(cfg, wf, { project: 'g/p', mr_iid: 3 }, alice)
  assert.match(id, /^run-[a-z0-9]+-[0-9a-f]{6}$/)
  const env = job.spec!.template.spec!.containers[0].env!
  assert.deepEqual(env.find((e) => e.name === 'GITLAB_TOKEN')!.valueFrom, { secretKeyRef: { name: 'renart-bot', key: 'GITLAB_TOKEN' } })
  assert.deepEqual(JSON.parse(env.find((e) => e.name === 'RENART_LAUNCHED_BY')!.value!), { username: 'alice', name: 'Alice', email: 'a@x' })
  assert.deepEqual(JSON.parse(env.find((e) => e.name === 'RENART_CONTEXT')!.value!), { project: 'g/p', mr_iid: 3 })
  assert.equal(job.metadata!.annotations!['renart.dev/user'], 'alice')
  assert.equal(job.metadata!.annotations!['renart.dev/user-id'], '7')
  assert.equal(job.metadata!.annotations!['renart.dev/workflow-source'], 'renart/workflows/summarize-mr.yaml@abc')
})

test('the CA mount is only added when configured', () => {
  const { job } = buildRun({ ...cfg, caConfigMap: undefined }, wf, { project: 'g/p', mr_iid: 3 }, alice)
  const pod = job.spec!.template.spec!
  assert.ok(!pod.volumes!.some((v) => v.name === 'ca'))
  assert.ok(!pod.containers[0].env!.some((e) => e.name === 'NODE_EXTRA_CA_CERTS'))
  assert.equal(pod.imagePullSecrets, undefined)
  assert.deepEqual(buildRun({ ...cfg, pullSecret: 'pull' }, wf, { project: 'g/p', mr_iid: 3 }, alice).job.spec!.template.spec!.imagePullSecrets, [{ name: 'pull' }])
})

test('engine settings reach the runner', () => {
  const runnerEnv = [{ name: 'RENART_ENGINE', value: 'openai' }, { name: 'MODEL', value: 'qwen' }]
  const env = buildRun({ ...cfg, runnerEnv }, wf, { project: 'g/p', mr_iid: 3 }, alice).job.spec!.template.spec!.containers[0].env!
  assert.deepEqual(env.filter((e) => ['RENART_ENGINE', 'MODEL'].includes(e.name)), runnerEnv)
})

test('a reopened pod log hands on only the new text', () => {
  const out: string[] = []
  const resume = resumableLog((t) => out.push(t))
  const first = resume.attempt()
  first('{"a":1}\n{"b"') // cut mid-line by the idle timeout
  const second = resume.attempt()
  second('{"a":1}\n')
  second('{"b":2}\n{"c":3}\n')
  assert.equal(out.join(''), '{"a":1}\n{"b":2}\n{"c":3}\n')
})
