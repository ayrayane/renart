import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Agent, fetch } from 'undici'
import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { insideWorkspace } from './workspace.ts'

// Compatibility engine: the same workflows and GitLab tools on any OpenAI-compatible server (vLLM, agentgateway…),
// with our own tool-calling loop. No Claude Code and no Anthropic API here.

// What both engines need from a tool definition (the SDK's tool() objects fit). Method syntax keeps handler args bivariant.
interface Tool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler(args: any, extra: unknown): Promise<{ content: ({ type: string; text?: string } | object)[] }>
}
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
export type Chat = (body: object) => Promise<{ choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[] }>

// A self-hosted model can take minutes before its first byte (long prompt, CPU, busy GPU): fetch's 5-minute
// header timeout would cut the run. The Job's own deadline still bounds it.
const slowModel = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000 })

export function openaiChat(baseUrl: string, apiKey?: string): Chat {
  return async (body) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      dispatcher: slowModel,
    })
    if (!res.ok) throw new Error(`model server ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return res.json() as ReturnType<Chat>
  }
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

// read_file / write_file / list_files, limited to the clone. The runner commits; the model never runs git or a shell.
export function fileTools(root: string): Tool[] {
  const inside = (p: string) => {
    if (!insideWorkspace(root, p)) throw new Error(`${p} is outside the repository`)
    return resolve(root, p)
  }
  return [
    tool('read_file', 'Read a text file of the repository (path relative to the repository root).', { path: z.string() },
      async ({ path }) => text((await readFile(inside(path), 'utf8')).slice(0, 200_000))),
    tool('write_file', 'Create or replace a file of the repository with the given content.', { path: z.string(), content: z.string() },
      async ({ path, content }) => {
        const file = inside(path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
        return text(`wrote ${path}`)
      }),
    tool('list_files', 'List the files of the repository, or of a directory in it.', { path: z.string().optional() },
      async ({ path }) => {
        const out: string[] = []
        const walk = async (dir: string) => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (e.name === '.git' || out.length >= 500) continue
            const full = join(dir, e.name)
            if (e.isDirectory()) await walk(full)
            else out.push(relative(root, full))
          }
        }
        await walk(inside(path ?? '.'))
        return text(out.join('\n'))
      }),
  ]
}

export interface OpenAIRun {
  chat: Chat
  model: string
  system: string
  prompt: string
  tools: Tool[]
  maxTurns: number
  log: (event: string, data?: object) => void
  // Raw tool output, for links to what was written.
  onToolResult?: (name: string, output: string) => void
  // Tools that deliver the result (comment, MR…). Small models often answer in text instead: they get one reminder.
  outputTools?: string[]
}

// Returns true when the model finished on its own within maxTurns.
export async function runOpenAI(r: OpenAIRun): Promise<boolean> {
  const byName = new Map(r.tools.map((t) => [t.name, t]))
  const functions = r.tools.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(z.object(t.inputSchema)) as Record<string, unknown>
    return { type: 'function', function: { name: t.name, description: t.description, parameters } }
  })
  const messages: Message[] = [{ role: 'system', content: r.system }, { role: 'user', content: r.prompt }]
  const expected = (r.outputTools ?? []).filter((t) => byName.has(t))
  let delivered = false
  let reminded = false
  for (let turn = 1; turn <= r.maxTurns; turn++) {
    const { message } = (await r.chat({ model: r.model, messages, tools: functions, tool_choice: 'auto' })).choices[0]
    if (message.content) r.log('text', { text: message.content })
    messages.push({ role: 'assistant', content: message.content, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) })
    if (!message.tool_calls?.length) {
      if (expected.length && !delivered && !reminded) {
        reminded = true
        messages.push({ role: 'user', content: `Le résultat doit être publié dans GitLab : appelle maintenant ${expected.join(' ou ')} avec ce que tu viens d'écrire.` })
        continue
      }
      r.log('result', { subtype: 'success', turns: turn, result: message.content })
      return true
    }
    for (const callInfo of message.tool_calls) {
      const t = byName.get(callInfo.function.name)
      let output: string
      try {
        if (!t) throw new Error(`unknown tool ${callInfo.function.name}`)
        // Models get the schema wrong more often than Claude: validate before running anything.
        const args = z.object(t.inputSchema).parse(JSON.parse(callInfo.function.arguments || '{}'))
        r.log('tool_use', { name: t.name, input: args })
        const result = await t.handler(args, {})
        if (expected.includes(t.name)) delivered = true
        output = result.content.map((c) => ('text' in c ? String(c.text) : '')).join('')
        r.onToolResult?.(t.name, output)
      } catch (e) {
        output = `Error: ${(e as Error).message}`
      }
      messages.push({ role: 'tool', tool_call_id: callInfo.id, content: output })
    }
  }
  r.log('result', { subtype: 'error_max_turns', turns: r.maxTurns })
  return false
}
