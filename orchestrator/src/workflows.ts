import { parse } from 'yaml'
import { Ajv } from 'ajv'
import schema from './workflow.schema.json' with { type: 'json' }
import type { RepoReader } from './gitlab.ts'

export type Context = 'merge_request' | 'issue' | 'pipeline' | 'project'

export interface Workflow {
  id: string
  label: string
  context: Context
  tools: string[]
  prompt: string
  workspace?: boolean
  // Extension-side display condition on a merge request.
  when?: 'has_conflicts' | 'unresolved_discussions' | 'dependency_update'
  // Where it came from, recorded on each run so we know which prompt ran.
  source: { project: string; path: string; sha: string }
}

export interface LoadResult {
  workflows: Workflow[]
  errors: { path: string; message: string }[]
}

export const REPO_DIR = '.renart/workflows'

const validate = new Ajv({ allErrors: true }).compile(schema)

export function workflowStore(server: RepoReader, instanceProject: string) {
  const cache = new Map<string, { sha: string; result: LoadResult }>()

  // One headSha call per request; files are only re-read when the branch moved.
  async function load(repo: RepoReader, project: string, dir: string): Promise<LoadResult> {
    const sha = await repo.headSha(project)
    if (!sha) return { workflows: [], errors: [] }
    const key = `${project}:${dir}`
    const hit = cache.get(key)
    if (hit?.sha === sha) return hit.result

    const result: LoadResult = { workflows: [], errors: [] }
    const paths = (await repo.listFiles(project, dir, sha)).filter((p) => /(^|\/)[^./][^/]*\.ya?ml$/.test(p)) // dotfiles such as .gitlab-ci.yml are not workflows
    // Read together: a cold cache after a commit was one round trip per file.
    const texts = await Promise.all(paths.map((path) => repo.readFile(project, path, sha).then((t) => ({ t }), (e: Error) => ({ e }))))
    paths.forEach((path, n) => {
      const got = texts[n]!
      try {
        if ('e' in got) throw got.e
        const doc = parse(got.t)
        if (!validate(doc)) {
          result.errors.push({ path, message: validate.errors!.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') })
          return
        }
        result.workflows.push({ ...(doc as Omit<Workflow, 'source'>), source: { project, path, sha } })
      } catch (e) {
        result.errors.push({ path, message: (e as Error).message })
      }
    })
    cache.set(key, { sha, result })
    return result
  }

  // Instance workflows, overridden or extended by the target repo's own, filtered by context.
  // The repo is read with the caller's token: no access, no head SHA, so neither its workflows nor a cache hit.
  async function list(project: string, caller: RepoReader, context?: Context): Promise<LoadResult> {
    const [instance, local] = await Promise.all([load(server, instanceProject, ''), load(caller, project, REPO_DIR)])
    const byId = new Map(instance.workflows.map((w) => [w.id, w]))
    // A repo adds workflows but cannot replace the instance's: whoever can push there could otherwise change what
    // "review-mr" does for everyone who runs it, signed with their name.
    const errors = [...instance.errors, ...local.errors]
    for (const w of local.workflows) {
      if (byId.has(w.id)) errors.push({ path: w.source.path, message: `id ${w.id} is an instance workflow and cannot be replaced` })
      else byId.set(w.id, w)
    }
    return {
      workflows: [...byId.values()].filter((w) => !context || w.context === context),
      errors,
    }
  }

  return { list }
}
