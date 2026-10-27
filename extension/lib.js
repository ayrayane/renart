// @ts-check
// Pure helpers, no chrome.* here, so node --test can import them.

// GitLab top-level routes that are not namespaces.
const RESERVED = new Set(['-', 'admin', 'dashboard', 'explore', 'groups', 'help', 'oauth', 'profile', 'projects', 'search', 'users'])

/**
 * What the current GitLab page is about.
 * @param {string} pageUrl
 * @param {string} gitlabUrl
 * @returns {{ project: string, context: 'merge_request' | 'issue' | 'pipeline' | 'project', iid?: number, job?: number } | null}
 */
export function parseContext(pageUrl, gitlabUrl) {
  const base = new URL(gitlabUrl)
  const url = new URL(pageUrl)
  const prefix = base.pathname.replace(/\/$/, '')
  if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) return null

  const [projectPath, rest = ''] = url.pathname.slice(prefix.length + 1).split('/-/')
  const segments = projectPath.split('/').filter(Boolean)
  // A project is always namespace/project, at least two segments.
  if (segments.length < 2 || RESERVED.has(segments[0])) return null
  const project = segments.join('/')

  // GitLab 18+ shows issues under /-/work_items/.
  const m = rest.match(/^(merge_requests|issues|work_items|pipelines|jobs)\/(\d+)(?:\/|$)/)
  if (!m) return { project, context: 'project' }
  // A job page is about its pipeline; the panel looks the pipeline up (`job` is the job id).
  if (m[1] === 'jobs') return { project, context: 'pipeline', job: Number(m[2]) }
  return { project, context: m[1] === 'merge_requests' ? 'merge_request' : m[1] === 'pipelines' ? 'pipeline' : 'issue', iid: Number(m[2]) }
}

/** @param {Uint8Array} bytes */
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** PKCE verifier + S256 challenge (RFC 7636). */
export async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

/**
 * Splits a server-sent events buffer into complete events; returns them and the unfinished tail.
 * @param {string} buffer
 * @returns {{ events: { event: string, data: string, id?: number }[], rest: string }}
 */
export function parseSSE(buffer) {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = blocks.filter(Boolean).map((block) => {
    let event = 'message'
    /** @type {number | undefined} */
    let id
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('data: ')) data.push(line.slice(6))
    }
    return id === undefined ? { event, data: data.join('\n') } : { event, data: data.join('\n'), id }
  })
  return { events, rest }
}

/**
 * Which workflow display conditions (`when`) hold on a merge request.
 * @param {{ has_conflicts?: boolean, source_branch?: string, labels?: string[] }} mr
 * @param {{ notes: { resolvable: boolean, resolved?: boolean }[] }[] | null} threads its discussions, if fetched
 */
export function mrConditions(mr, threads) {
  return {
    has_conflicts: Boolean(mr.has_conflicts),
    unresolved_discussions: (threads ?? []).some((d) => d.notes[0]?.resolvable && !d.notes.every((n) => n.resolved)),
    // Renovate and Dependabot name their branches after themselves; other tools use a "dependencies" label.
    dependency_update: /^(renovate|dependabot)[/-]/.test(mr.source_branch ?? '') || (mr.labels ?? []).some((l) => /^dependenc(y|ies)$/i.test(l)),
  }
}

/**
 * The GitLab address from what was pasted: a page URL (…/group/project/-/merge_requests/6) is cut back to the host.
 * shortcut: a GitLab under a sub-path loses it when a page URL is pasted, type the base URL then.
 * @param {string} pasted
 */
export function gitlabBase(pasted) {
  try {
    const u = new URL(pasted)
    return u.pathname.includes('/-/') ? u.origin : pasted.replace(/\/$/, '')
  } catch {
    return pasted
  }
}
