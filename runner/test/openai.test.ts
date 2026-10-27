import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOpenAI, fileTools, type Chat } from '../src/openai.ts'
import { pickTools } from '../src/tools.ts'

// A scripted model: each call returns the next canned assistant message and records what it was sent.
function fakeModel(script: object[]) {
  const sent: any[] = []
  const chat: Chat = async (body) => { sent.push(structuredClone(body)); return { choices: [{ message: script[sent.length - 1] as any }] } }
  return { chat, sent }
}
const call = (id: string, name: string, args: object) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })

test('openai engine: runs GitLab tools the model calls, returns results, stops on the final answer', async () => {
  const gitlab: unknown[] = []
  const tools = pickTools(async (method, path, body) => { gitlab.push({ method, path, body }); return method === 'GET' ? { title: 'Bug' } : { id: 9 } }, ['get_issue', 'comment_issue'], undefined, undefined, undefined, { issue_iid: 1 })
  const { chat, sent } = fakeModel([
    { content: null, tool_calls: [call('c1', 'get_issue', { iid: 1 })] },
    { content: 'Je commente.', tool_calls: [call('c2', 'comment_issue', { iid: 1, body: 'Plan' })] },
    { content: 'Fait.' },
  ])
  const events: [string, any][] = []
  const links: string[] = []
  const ok = await runOpenAI({ chat, model: 'm', system: 's', prompt: 'p', tools, maxTurns: 5, log: (e, d) => events.push([e, d]), onToolResult: (n, o) => links.push(`${n}:${o}`) })
  assert.equal(ok, true)
  assert.deepEqual(sent[0].tools.map((t: any) => t.function.name), ['get_issue', 'comment_issue'])
  assert.equal(sent[0].tools[0].function.parameters.type, 'object')
  assert.deepEqual(gitlab.map((g: any) => `${g.method} ${g.path}`), ['GET /issues/1', 'GET /issues/1/notes?per_page=100&sort=asc', 'POST /issues/1/notes'])
  assert.equal(sent[2].messages.at(-1).role, 'tool')
  assert.deepEqual(events.map((e) => e[0]), ['tool_use', 'text', 'tool_use', 'text', 'result'])
  assert.equal(links.at(-1), 'comment_issue:{"id":9}')
})

test('openai engine: bad arguments and unknown tools go back to the model as errors, nothing runs', async () => {
  let ran = false
  const tools = pickTools(async () => { ran = true; return {} }, ['comment_issue'], undefined, undefined, undefined, { issue_iid: 1 })
  const { chat, sent } = fakeModel([
    { content: null, tool_calls: [call('c1', 'comment_issue', { iid: 'one' }), call('c2', 'delete_project', {})] },
    { content: 'Désolé.' },
  ])
  assert.equal(await runOpenAI({ chat, model: 'm', system: 's', prompt: 'p', tools, maxTurns: 3, log: () => {} }), true)
  assert.equal(ran, false)
  const replies = sent[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)
  assert.match(replies[0], /^Error:/)
  assert.match(replies[1], /unknown tool delete_project/)
})

test('openai engine: stops at maxTurns', async () => {
  const { chat } = fakeModel(Array(3).fill({ content: null, tool_calls: [call('c', 'list_files', {})] }))
  const events: string[] = []
  assert.equal(await runOpenAI({ chat, model: 'm', system: 's', prompt: 'p', tools: fileTools(mkdtempSync(join(tmpdir(), 'r-'))), maxTurns: 2, log: (e) => events.push(e) }), false)
  assert.equal(events.at(-1), 'result')
})

test('file tools stay inside the clone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r-'))
  const [read, write, list] = fileTools(root)
  await write.handler({ path: 'src/a.py', content: 'x = 1\n' }, {})
  assert.equal(readFileSync(join(root, 'src/a.py'), 'utf8'), 'x = 1\n')
  assert.deepEqual((await list.handler({}, {})).content, [{ type: 'text', text: 'src/a.py' }])
  await assert.rejects(read.handler({ path: '/proc/self/environ' }, {}), /outside the repository/)
  await assert.rejects(write.handler({ path: '../escape', content: '' }, {}), /outside the repository/)
  await assert.rejects(read.handler({ path: '.git/config' }, {}), /outside the repository/)
})

test('openai engine: a model that answers in text instead of posting gets one reminder', async () => {
  const posted: unknown[] = []
  const tools = pickTools(async (m, _p, body) => { if (m === 'POST') posted.push(body); return { id: 1 } }, ['get_issue', 'comment_issue'], undefined, undefined, undefined, { issue_iid: 1 })
  const { chat, sent } = fakeModel([
    { content: 'Voici le plan…' },
    { content: null, tool_calls: [call('c1', 'comment_issue', { iid: 1, body: 'Voici le plan…' })] },
    { content: 'Publié.' },
  ])
  assert.equal(await runOpenAI({ chat, model: 'm', system: 's', prompt: 'p', tools, maxTurns: 5, log: () => {}, outputTools: ['comment_issue'] }), true)
  assert.match(sent[1].messages.at(-1).content, /appelle maintenant comment_issue/)
  assert.equal(posted.length, 1)
  // Only once: a model that still refuses ends there.
  const stubborn = fakeModel([{ content: 'a' }, { content: 'b' }, { content: 'c' }])
  await runOpenAI({ chat: stubborn.chat, model: 'm', system: 's', prompt: 'p', tools, maxTurns: 5, log: () => {}, outputTools: ['comment_issue'] })
  assert.equal(stubborn.sent.length, 2)
})
