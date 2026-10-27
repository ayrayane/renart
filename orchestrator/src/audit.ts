import { appendFile, readFile } from 'node:fs/promises'

export interface AuditRecord {
  at: string
  id: string
  user: string
  project: string
  workflow: string
  workflowSource: string
  instruction?: string
  status: string
  durationMs: number
  tools: string[]
  links: string[]
  turns?: number
  costUsd?: number
  error?: string
}

// What the runner's event lines say about a run (one JSON object per line; anything else is ignored).
export function summarize(lines: string[]) {
  const out: Pick<AuditRecord, 'tools' | 'links' | 'turns' | 'costUsd' | 'error'> = { tools: [], links: [] }
  for (const line of lines) {
    let e: { event?: string; name?: string; url?: string; turns?: number; cost_usd?: number; message?: string }
    try { e = JSON.parse(line) } catch { continue }
    if (e.event === 'tool_use' && e.name) out.tools.push(e.name.replace('mcp__gitlab__', ''))
    else if (e.event === 'link' && e.url) out.links.push(e.url)
    else if (e.event === 'result') { out.turns = e.turns; out.costUsd = e.cost_usd }
    else if (e.event === 'error' && e.message) out.error = e.message
  }
  return out
}

// Append-only JSON Lines file on a volume: one record per finished run, readable with jq.
export function auditLog(file: string | undefined) {
  return {
    async append(record: AuditRecord) {
      if (file) await appendFile(file, `${JSON.stringify(record)}\n`)
    },
    // Ids already recorded, to resume only the runs that are missing after a restart.
    async ids() {
      if (!file) return new Set<string>()
      const text = await readFile(file, 'utf8').catch(() => '')
      return new Set(text.split('\n').filter(Boolean).map((l) => { try { return (JSON.parse(l) as AuditRecord).id } catch { return '' } }))
    },
  }
}
