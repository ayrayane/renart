import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { buildSnapshot } from './graph.ts'

// Entry point of a code graph build Job: check out project@sha, index it, upload the snapshot to the orchestrator.
const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const dir = env('WORK_DIR')
const started = Date.now()
await buildSnapshot({
  dir, gitlabUrl: env('GITLAB_URL'), botToken: env('GITLAB_TOKEN'), caFile: process.env.NODE_EXTRA_CA_CERTS,
  project: env('PROJECT'), ref: env('REF'), sha: env('SHA'),
})
console.log(JSON.stringify({ event: 'indexed', ms: Date.now() - started }))

const tar = spawn('tar', ['-czf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'inherit'] })
const tarDone = new Promise<number>((resolve) => tar.on('close', resolve))
const res = await fetch(env('UPLOAD_URL'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip', 'X-Renart-Upload-Token': env('UPLOAD_TOKEN') },
  body: Readable.toWeb(tar.stdout) as ReadableStream,
  duplex: 'half',
} as RequestInit)
if ((await tarDone) !== 0) throw new Error('tar failed')
if (!res.ok) throw new Error(`upload refused: ${res.status} ${(await res.text()).slice(0, 300)}`)
console.log(JSON.stringify({ event: 'uploaded', ms: Date.now() - started }))
