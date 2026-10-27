// Minimal GitLab REST client: only the repository reads the orchestrator needs.
export interface RepoReader {
  // SHA of the latest commit on the default branch, or null if the project or branch is missing.
  headSha(project: string): Promise<string | null>
  // Blob paths directly under `dir` at `sha`; [] if the directory does not exist.
  listFiles(project: string, dir: string, sha: string): Promise<string[]>
  readFile(project: string, path: string, sha: string): Promise<string>
}

export interface Caller {
  // GitLab's numeric id: a username can be changed and taken by someone else.
  id: number
  username: string
  name: string
  // For commit authorship; GitLab shows the user's own address to them.
  email: string
  // 10 guest … 50 owner; admins count as 50.
  accessLevel: number
}

// Who the token belongs to and their role on `project`, or null if they cannot see it. GitLab accepts PATs and OAuth tokens as Bearer.
export async function projectAccess(baseUrl: string, token: string, project: string): Promise<Caller | null> {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v4`
  const headers = { Authorization: `Bearer ${token}` }
  const [user, proj] = await Promise.all([fetch(`${api}/user`, { headers }), fetch(`${api}/projects/${encodeURIComponent(project)}`, { headers })])
  if (!user.ok || !proj.ok) return null
  const u = (await user.json()) as { id: number; username: string; name: string; email?: string; commit_email?: string; public_email?: string; is_admin?: boolean }
  const p = (await proj.json()) as { permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null } }
  const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0, u.is_admin ? 50 : 0)
  return { id: u.id, username: u.username, name: u.name, email: u.commit_email || u.email || u.public_email || `${u.username}@users.noreply`, accessLevel: level }
}

// The branch a pipeline ran on, which its fix targets: its ref, or for a merge request pipeline the MR's source branch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pipelineBranch(get: (path: string) => Promise<any>, pipelineId: number): Promise<string> {
  const p = await get(`/pipelines/${pipelineId}`)
  if (p.tag) throw new Error(`pipeline ${pipelineId} ran on a tag, there is no branch to fix`)
  const mr = String(p.ref).match(/^refs\/merge-requests\/(\d+)\/(head|merge|train)$/)
  return mr ? mrBranch(get, Number(mr[1])) : p.ref
}

// The source branch of a merge request, where work on that MR goes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mrBranch(get: (path: string) => Promise<any>, iid: number): Promise<string> {
  const m = await get(`/merge_requests/${iid}`)
  // shortcut: fork MRs are refused, the bot cannot push to the fork; support them by opening the fix MR in the fork.
  if (m.source_project_id !== m.target_project_id) throw new Error('merge requests from a fork are not supported')
  return m.source_branch
}

export function gitlab(baseUrl: string, token: string): RepoReader {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v4/projects/`
  const get = async (path: string) => {
    const res = await fetch(api + path, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitLab ${res.status} on ${path.split('?')[0]}`)
    return res
  }
  const id = encodeURIComponent

  return {
    async headSha(project) {
      const res = await get(`${id(project)}/repository/commits?per_page=1`)
      const commits = (await res?.json()) as { id: string }[] | undefined
      return commits?.[0]?.id ?? null
    },
    async listFiles(project, dir, sha) {
      const res = await get(`${id(project)}/repository/tree?path=${id(dir)}&ref=${sha}&per_page=100`)
      const entries = ((await res?.json()) ?? []) as { type: string; path: string }[]
      return entries.filter((e) => e.type === 'blob').map((e) => e.path)
    },
    async readFile(project, path, sha) {
      const res = await get(`${id(project)}/repository/files/${id(path)}/raw?ref=${sha}`)
      if (!res) throw new Error(`GitLab 404 on ${path}`)
      return res.text()
    },
  }
}
