import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditLog, summarize } from '../src/audit.ts'

test('summarize keeps tools, links, turns, cost and the last error; skips noise', () => {
  const s = summarize([
    '{"event":"tool_use","name":"mcp__gitlab__get_issue","input":{}}',
    'not json',
    '{"event":"link","label":"Commentaire","url":"https://gl/x#note_1"}',
    '{"event":"text","text":"done"}',
    '{"event":"result","subtype":"success","turns":3,"cost_usd":0.05}',
  ])
  assert.deepEqual(s, { tools: ['get_issue'], links: ['https://gl/x#note_1'], turns: 3, costUsd: 0.05 })
})

test('records are appended as JSON lines', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl')
  const log = auditLog(file)
  const rec = { at: 't', id: 'r1', user: 'a', project: 'g/p', workflow: 'w', workflowSource: 's', status: 'succeeded', durationMs: 1, tools: [], links: [] }
  await log.append(rec)
  await log.append({ ...rec, id: 'r2' })
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['r1', 'r2'])
})

test('ids lists what is already recorded; a missing file is empty', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl')
  assert.deepEqual([...(await auditLog(file).ids())], [])
  const rec = { at: 't', id: 'r1', user: 'a', project: 'g/p', workflow: 'w', workflowSource: 's', status: 'succeeded', durationMs: 1, tools: [], links: [] }
  await auditLog(file).append(rec)
  assert.deepEqual([...(await auditLog(file).ids())], ['r1'])
})
