// @ts-check
import { parseContext, mrConditions } from './lib.js'
import { blocks } from './md.js'
import { el, icon, spinner, clock, humanError } from './ui.js'
import { getConfig, login, logout, accessToken, orchestrator, followRun, gitlabApi } from './api.js'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const VIEWS = ['setup', 'signin', 'nocontext', 'launch', 'running']
/** @param {string} name */
function show(name) {
  for (const v of VIEWS) $(v).hidden = v !== name
  $('runFooter').hidden = name !== 'running'
}

/** @type {(() => void) | null} */
let retry = null
/** @param {unknown} e @param {() => void} [again] */
function fail(e, again) {
  $('errorText').textContent = humanError(e)
  retry = again ?? null
  $('retry').hidden = !again
  $('error').hidden = false
  $('error').scrollIntoView({ block: 'nearest' })
}
const clearError = () => { $('error').hidden = true }

/**
 * The run on screen. Saved in session storage, so closing and reopening the panel picks it up again.
 * @typedef {{ id: string, label: string, target: { context: string, iid?: number, job?: number }, title: string, tabId?: number, pageUrl?: string, started: number }} SavedRun
 * @typedef {SavedRun & { abort: AbortController, timer?: number }} ActiveRun
 * @type {ActiveRun | null}
 */
let run = null
// A click is being sent: a second click must not start a second run.
let launching = false
/** @type {Map<string, Workflow[]>} last list per project: shown at once, refreshed behind */
const workflowCache = new Map()
/** @type {ReturnType<typeof parseContext>} */
let ctx = null
let refreshes = 0
// Title of the page the panel shows, for the run view.
let title = ''

const WORKFLOW_ICON = {
  'review-mr': 'review', 'summarize-mr': 'summary', 'plan-issue': 'plan', 'issue-to-mr': 'branch', 'fix-ci': 'pipeline',
  'describe-mr': 'edit', 'apply-review': 'comment', 'ask-project': 'question', 'ask-mr': 'question', 'tests-mr': 'check',
  'e2e-tests': 'flask', 'resolve-conflicts': 'merge_request', 'summarize-issue': 'summary', 'security-review': 'shield', 'dependency-update': 'package',
}
const PLACE = { merge_request: 'une merge request', issue: 'une issue', pipeline: 'une pipeline en échec', project: 'un projet' }
const STATE = {
  opened: 'Ouverte', merged: 'Fusionnée', closed: 'Fermée', locked: 'Verrouillée',
  failed: 'En échec', success: 'Réussie', running: 'En cours', pending: 'En attente', canceled: 'Annulée',
}
/** "!12", "#3", "Pipeline #41" (with its job on a job page). @param {{ context: string, iid?: number, job?: number }} c */
const refOf = (c) => c.context === 'merge_request' ? `!${c.iid}` : c.context === 'issue' ? `#${c.iid}` : `${c.job ? `Job #${c.job} · ` : ''}Pipeline #${c.iid}`
// Most used first; ids not listed follow, in the order the orchestrator gives. Beyond SHOWN, they fold into « Autres actions ».
const PRIORITY = ['review-mr', 'summarize-mr', 'ask-mr', 'describe-mr', 'security-review', 'tests-mr', 'e2e-tests', 'plan-issue', 'issue-to-mr', 'summarize-issue', 'ask-project']
const SHOWN = 4
/** @param {{ id: string }} w */
const rank = (w) => { const i = PRIORITY.indexOf(w.id); return i < 0 ? PRIORITY.length : i }
// Why a conditional action is suggested on this merge request.
const REASON = { has_conflicts: 'Conflits avec la branche cible', unresolved_discussions: 'Fils de revue non résolus', dependency_update: 'Mise à jour de dépendance' }
// What the cluster is doing while the run's pod starts.
const WAIT = { Scheduling: "En attente d'une place sur le cluster", Pending: "En attente d'une place sur le cluster", ContainerCreating: "Démarrage de l'agent", PodInitializing: "Démarrage de l'agent" }
/** "il y a 5 min". @param {string} iso */
function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return min < 60 ? `il y a ${Math.max(min, 1)} min` : min < 1440 ? `il y a ${Math.round(min / 60)} h` : `il y a ${Math.round(min / 1440)} j`
}

// ── Account ────────────────────────────────────────────────────────────────
/** @type {{ name: string, username: string, avatar_url?: string } | null} */
let me = null
/** @param {import('./api.js').Config} config */
async function loadAccount(config) {
  me ??= await gitlabApi(config, '/user')
  const button = $('account')
  button.hidden = false
  const initials = (me?.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  const avatar = me?.avatar_url
    ? el('img', { className: 'avatar', src: me.avatar_url, alt: '' })
    : el('span', { className: 'avatar' }, initials)
  button.replaceChildren(avatar)
  button.setAttribute('aria-label', me ? `Compte : ${me.name}` : 'Compte')
  $('menuUser').replaceChildren(el('strong', {}, me?.name ?? 'Connecté'), me ? el('span', { className: 'muted' }, `@${me.username}`) : '')
}

function toggleMenu(open = $('menu').hidden) {
  $('menu').hidden = !open
  $('account').setAttribute('aria-expanded', String(open))
  if (open) $('logout').focus()
}

// ── Page context and actions ──────────────────────────────────────────────
/** Title and state of the page, best effort; returns the page's GitLab object (null if unavailable). @param {import('./api.js').Config} config @param {NonNullable<typeof ctx>} c @param {number} mine */
async function loadContext(config, c, mine) {
  const id = encodeURIComponent(c.project)
  const path = c.context === 'merge_request' ? `/projects/${id}/merge_requests/${c.iid}` : c.context === 'issue' ? `/projects/${id}/issues/${c.iid}`
    : c.context === 'pipeline' ? `/projects/${id}/pipelines/${c.iid}` : `/projects/${id}`
  const data = await gitlabApi(config, path)
  if (mine !== refreshes) return
  // A pipeline is named after where it ran: its branch, or the merge request of a merge request pipeline.
  const pipelineTitle = data?.ref && String(data.ref).replace(/^refs\/merge-requests\/(\d+)\/\w+$/, 'Merge request !$1')
  // GitLab keeps "Draft:" in the title; it reads better as a badge.
  title = String(data?.title ?? (c.context === 'pipeline' ? data?.name || pipelineTitle : data?.name) ?? (c.context === 'project' ? c.project.split('/').pop() : refOf(c))).replace(/^(draft|wip):\s*/i, '')
  $('ctxTitle').textContent = title
  const state = /** @type {keyof typeof STATE | undefined} */ (c.context === 'pipeline' ? data?.status : data?.state)
  const badges = c.context === 'project' || !state ? [] : [el('span', { className: `badge ${state}` }, STATE[state] ?? state)]
  if (badges.length && data?.draft) badges.push(el('span', { className: 'badge draft' }, 'Brouillon'))
  $('ctxBadges').replaceChildren(...badges)
  return data
}

/** @param {number} n */
function skeletonRows(n) {
  return Array.from({ length: n }, () => el('li', {}, el('div', { className: 'action', 'aria-hidden': 'true' },
    el('span', { className: 'skeleton', style: 'width:32px;height:32px' }),
    el('span', { className: 'action-text' }, el('span', { className: 'skeleton', style: 'width:55%;height:12px;margin-bottom:6px' }), el('span', { className: 'skeleton', style: 'width:80%;height:10px' })))))
}

// Re-reads config, login and the active tab, then shows the matching view. Never interrupts a run.
// Tab events fire in bursts (activated, then updated): only the latest call may touch the page.
async function refresh() {
  if (run) return
  const mine = ++refreshes
  clearError()
  const config = await getConfig()
  if (mine !== refreshes) return
  $('account').hidden = true
  if (!config) return show('setup')
  const token = await accessToken(config)
  if (mine !== refreshes) return
  if (!token) {
    const { expired } = await chrome.storage.local.get('expired')
    $('signinNote').hidden = !expired
    return show('signin')
  }
  loadAccount(config)
  /** @type {{ run?: SavedRun }} */
  const { run: saved } = await chrome.storage.session.get('run')
  if (mine !== refreshes || run) return
  if (saved) return watch(config, { ...saved, abort: new AbortController() }, true)

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (mine !== refreshes) return
  ctx = tab?.url ? parseContext(tab.url, config.gitlabUrl) : null
  if (ctx?.job) {
    // A job page: act on its pipeline.
    const job = await gitlabApi(config, `/projects/${encodeURIComponent(ctx.project)}/jobs/${ctx.job}`)
    if (mine !== refreshes) return
    ctx = job?.pipeline?.id ? { project: ctx.project, context: 'pipeline', iid: job.pipeline.id, job: ctx.job } : { project: ctx.project, context: 'project' }
  }
  if (!ctx) return show('nocontext')
  const c = ctx

  $('ctxIcon').replaceChildren(icon(c.context))
  $('ctxRef').textContent = c.context === 'project' ? c.project : `${refOf(c)} · ${c.project}`
  $('ctxTitle').replaceChildren(el('span', { className: 'skeleton', style: 'width:70%;height:14px;margin:3px 0' }))
  $('ctxBadges').replaceChildren()
  title = ''
  // Never leave the previous page's actions clickable while this page's list loads.
  $('launchBody').hidden = false
  $('composer').hidden = false
  $('suggestedBox').hidden = true
  $('more').hidden = true
  $('actions').replaceChildren(...skeletonRows(2))
  show('launch')
  // Everything the list needs, asked at once: page, workflows, failed pipelines, review threads.
  const page = loadContext(config, c, mine).catch(() => null)
  const id = encodeURIComponent(c.project)
  const failedReq = c.context === 'merge_request' || c.context === 'project' ? failedPipelines(config, c) : Promise.resolve([])
  const threadsReq = c.context === 'merge_request' ? gitlabApi(config, `/projects/${id}/merge_requests/${c.iid}/discussions?per_page=100`) : Promise.resolve(null)
  const fresh = orchestrator(config, `/workflows?${new URLSearchParams({ project: c.project })}`).then((r) => r.json())
    .then((/** @type {{ workflows: Workflow[] }} */ { workflows }) => { workflowCache.set(c.project, workflows); return workflows })
  fresh.catch(() => {})

  try {
    const all = workflowCache.get(c.project) ?? await fresh
    const [failed, mr, threads] = await Promise.all([failedReq, page, threadsReq])
    if (mine !== refreshes) return
    // Pipeline actions also show on a merge request or a project, on the failed pipeline the user picks.
    const fixers = failed.length && (c.context === 'merge_request' || c.context === 'project') ? all.filter((w) => w.context === 'pipeline') : []
    /** @type {Partial<Record<When, boolean>>} */
    const signals = mr && c.context === 'merge_request' ? mrConditions(mr, threads) : {}
    // What fits the situation (conflicts, review threads, a failed pipeline), with why; then the usual actions, most used first.
    const suggested = all.filter((w) => w.context === c.context && w.when && signals[w.when])
    const regular = all.filter((w) => w.context === c.context && !w.when).sort((a, b) => rank(a) - rank(b))
    const failNote = failed.length === 1 ? `Pipeline #${failed[0]?.id} en échec` : `${failed.length} pipelines en échec`
    $('suggested').replaceChildren(...suggested.map((w) => actionRow(w, undefined, REASON[/** @type {When} */ (w.when)])), ...fixers.map((w) => actionRow(w, failed, failNote)))
    $('suggestedBox').hidden = !suggested.length && !fixers.length
    $('actions').replaceChildren(...regular.slice(0, SHOWN).map((w) => actionRow(w)))
    if (!regular.length) $('actions').replaceChildren(el('li', {}, el('p', { className: 'action muted small' }, `Aucune action configurée pour ${PLACE[c.context]}.`)))
    $('moreActions').replaceChildren(...regular.slice(SHOWN).map((w) => actionRow(w)))
    $('moreLabel').textContent = `Autres actions (${regular.length - SHOWN})`
    $('more').hidden = regular.length <= SHOWN
  } catch (e) {
    if (mine !== refreshes) return
    // An error replaces the list: no empty frame, no instruction box for actions that are not there.
    $('launchBody').hidden = true
    $('composer').hidden = true
    // A revoked token reads as "no access": GitLab's /user tells, and a 401 there signs the user out.
    if (/cannot access/.test(String(e))) await gitlabApi(config, '/user')
    fail(e, refresh)
  }
}

/** @typedef {'has_conflicts' | 'unresolved_discussions' | 'dependency_update'} When */
/** @typedef {{ id: string, label: string, description?: string, context: keyof typeof PLACE, when?: When }} Workflow */

/** @typedef {{ id: number, ref: string, sha: string, status: string, created_at: string }} Pipeline */

/**
 * Failed pipelines a fix can start from: on a merge request, those since its last green pipeline (an older failure
 * is already fixed); on a project, the latest failures. Newest first, so the likely one is preselected.
 * @param {import('./api.js').Config} config @param {NonNullable<typeof ctx>} c @returns {Promise<Pipeline[]>}
 */
async function failedPipelines(config, c) {
  const id = encodeURIComponent(c.project)
  /** @type {Pipeline[]} */
  const list = (await gitlabApi(config, c.context === 'merge_request' ? `/projects/${id}/merge_requests/${c.iid}/pipelines` : `/projects/${id}/pipelines?status=failed&per_page=5`)) ?? []
  const green = list.findIndex((p) => p.status === 'success')
  // Renart's own fix branches are not what the user came to fix.
  return list.slice(0, green < 0 ? undefined : green).filter((p) => p.status === 'failed' && !p.ref.startsWith('renart/')).slice(0, 5)
}

/** "!12" for a merge request pipeline's ref, the branch name otherwise. @param {string} ref */
const refLabel = (ref) => ref.replace(/^refs\/merge-requests\/(\d+)\/\w+$/, '!$1')

/** A pipeline the way GitLab lists one: status, #id and ref, then commit and age below (left out in the closed toggle). @param {Pipeline} p @param {boolean} [compact] */
const pipelineLine = (p, compact = false) => el('span', { className: 'pl' },
  el('span', { className: 'pl-head' },
    el('span', { className: `ci ${p.status}`, title: STATE[/** @type {keyof typeof STATE} */ (p.status)] ?? p.status }, icon(p.status === 'failed' ? 'ci_failed' : 'pipeline')),
    el('span', { className: 'pl-id' }, `#${p.id}`),
    el('span', { className: 'pl-ref' }, icon('branch'), el('span', {}, refLabel(p.ref)))),
  !compact && el('span', { className: 'pl-meta' }, `${p.sha.slice(0, 8)} · ${ago(p.created_at)}`))

/**
 * GitLab-style listbox of pipelines (toggle + popover list, arrows/Enter/Escape). With one pipeline, a plain line.
 * @param {Pipeline[]} pipelines @param {string} label @returns {{ node: HTMLElement, value: () => number }}
 */
function pipelinePicker(pipelines, label) {
  let chosen = pipelines[0]
  if (pipelines.length === 1) return { node: el('div', { className: 'pick-row' }, pipelineLine(chosen)), value: () => chosen.id }
  // No aria-label: the toggle's text (#id, branch) is its name, so the chosen pipeline is heard.
  const toggle = el('button', { className: 'lb-toggle', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: label })
  const list = el('ul', { className: 'lb-list', role: 'listbox', tabIndex: -1, 'aria-label': label })
  list.hidden = true
  const paint = () => {
    toggle.replaceChildren(pipelineLine(chosen, true), icon('chevron', 'icon lb-chevron'))
    for (const li of /** @type {HTMLElement[]} */ ([...list.children])) li.setAttribute('aria-selected', String(li.dataset.id === String(chosen.id)))
  }
  const close = (focus = true) => { list.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus) toggle.focus() }
  const choose = (/** @type {Pipeline} */ p) => { chosen = p; paint(); close() }
  list.append(...pipelines.map((p) => {
    const li = el('li', { role: 'option', tabIndex: -1, 'data-id': String(p.id), onclick: () => choose(p) }, icon('check', 'icon lb-check'), pipelineLine(p))
    li.addEventListener('keydown', (e) => {
      const items = /** @type {HTMLElement[]} */ ([...list.children])
      const at = items.indexOf(li)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(p) }
      else if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape')
    })
    return li
  }))
  toggle.addEventListener('click', () => {
    const open = list.hidden
    list.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) /** @type {HTMLElement | null} */ (list.querySelector('[aria-selected="true"]'))?.focus()
  })
  toggle.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && list.hidden) { e.preventDefault(); toggle.click() } })
  const node = el('div', { className: 'pick-row lb' }, toggle, list)
  // Closes when focus leaves the picker (a click elsewhere, Tab), without a page-wide listener per refresh.
  node.addEventListener('focusout', (e) => { if (!node.contains(/** @type {Node | null} */ (e.relatedTarget))) close(false) })
  paint()
  return { node, value: () => chosen.id }
}

/** One action button; with `pipelines`, a picker of the pipeline it runs on; `reason` says why it is suggested. @param {Workflow} w @param {Pipeline[]} [pipelines] @param {string} [reason] */
function actionRow(w, pipelines, reason) {
  const picker = pipelines && pipelinePicker(pipelines, `Pipeline à réparer avec « ${w.label} »`)
  return el('li', {},
    el('button', { className: 'action', type: 'button', onclick: () => launch(w, picker?.value()) },
      el('span', { className: 'action-icon' }, icon(/** @type {any} */ (WORKFLOW_ICON[/** @type {keyof typeof WORKFLOW_ICON} */ (w.id)] ?? 'sparkle'))),
      el('span', { className: 'action-text' }, el('span', { className: 'action-name' }, w.label),
        reason ? el('span', { className: 'action-desc reason' }, reason) : w.description && el('span', { className: 'action-desc' }, w.description)),
      icon('chevron', 'icon go')),
    picker?.node)
}

// ── Run ────────────────────────────────────────────────────────────────────
const TOOL_TEXT = {
  get_merge_request: 'Lecture de la merge request', get_issue: "Lecture de l'issue",
  comment_merge_request: 'Commentaire sur la merge request', comment_diff_line: 'Commentaire sur une ligne',
  comment_issue: "Commentaire sur l'issue", create_merge_request: 'Création de la merge request en brouillon',
  get_pipeline: 'Lecture de la pipeline', get_job_log: 'Lecture du log du job',
  get_discussions: 'Lecture des fils de revue', reply_to_discussion: 'Réponse dans un fil de revue',
  update_merge_request_description: 'Mise à jour de la description', merge_target_branch: 'Fusion de la branche cible',
  code_graph_explore: 'Code graph : exploration', code_graph_callers: 'Code graph : appelants',
  code_graph_impact: "Code graph : impact d'un changement", code_graph_affected: 'Code graph : tests concernés',
  Read: 'Lecture du fichier', Edit: 'Modification du fichier', Write: 'Écriture du fichier', Glob: 'Exploration du dépôt', Grep: 'Recherche dans le code',
}

/** @type {HTMLElement | null} */
let current = null
/** Marks the running step as finished and appends a new running one. @param {string} text @param {string} [detail] */
function step(text, detail) {
  settle('done')
  const mark = el('span', { className: 'step-mark' }, spinner())
  current = el('li', { className: 'step current' }, mark, el('span', {}, text, detail ? el('span', { className: 'step-detail' }, detail) : null))
  $('steps').append(current)
  current.scrollIntoView({ block: 'nearest' })
}
/** Sets the running step's detail line (what the cluster is doing while the agent starts). @param {string} text */
function detail(text) {
  if (!current || !text) return
  let d = current.querySelector('.step-detail')
  if (!d) { d = el('span', { className: 'step-detail' }); current.lastElementChild?.append(d) }
  d.textContent = text
}
/** @param {'done' | 'error' | 'stopped'} how */
function settle(how) {
  if (!current) return
  current.className = `step ${how === 'stopped' ? '' : how}`
  current.querySelector('.step-mark')?.replaceChildren(icon(how === 'done' ? 'check' : how === 'error' ? 'x' : 'stop'))
  current = null
}

/** @param {string} name @param {any} input */
function describeTool(name, input) {
  const short = name.replace('mcp__gitlab__', '')
  const text = TOOL_TEXT[/** @type {keyof typeof TOOL_TEXT} */ (short)] ?? short
  const file = input?.file_path ?? input?.new_path
  const line = input?.new_line ?? input?.old_line
  const detail = file ? `${String(file).replace(/^\/home\/runner\/repo\//, '')}${line ? `:${line}` : ''}`
    : input?.symbol ?? input?.question ?? (Array.isArray(input?.files) ? input.files.join(', ') : input?.pattern) ?? (input?.job_id ? `job ${input.job_id}` : undefined)
  return { text, detail }
}

/** The agent's answer as DOM nodes, never HTML. @param {string} text */
function answer(text) {
  /** @param {import('./md.js').Inline[]} parts @returns {(string | Node)[]} */
  const inline = (parts) => parts.map((p) =>
    p.type === 'strong' ? el('strong', {}, ...inline(p.children))
      : p.type === 'code' ? el('code', {}, p.text)
        : p.type === 'link' ? el('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.text)
          : p.text)
  const body = blocks(text).map((b) => b.type === 'ul'
    ? el('ul', {}, ...b.items.map((i) => el('li', {}, ...inline(i))))
    : el(b.type === 'h' ? 'h2' : 'p', {}, ...inline(b.inline)))
  $('answers').append(el('div', { className: 'answer', tabIndex: -1 }, el('div', { className: 'answer-head' }, icon('sparkle'), 'Renart'), ...body))
}

/** @param {{ label: string, url: string }} link */
function addLink(link) {
  $('links').hidden = false
  const a = el('a', { href: link.url }, icon(link.url.includes('#note_') ? 'comment' : 'merge_request'), link.label)
  // Open it in the GitLab tab the run belongs to, not a new one.
  a.addEventListener('click', (e) => { if (run?.tabId) { e.preventDefault(); chrome.tabs.update(run.tabId, { url: link.url, active: true }) } })
  $('linkList').append(el('li', {}, a))
}

/** @typedef {'running' | 'succeeded' | 'failed' | 'stopped' | 'lost'} RunStatus */
const STATUS_TEXT = { running: 'En cours ·', succeeded: 'Terminé en', failed: 'Échec après', stopped: 'Arrêté après', lost: 'Suivi interrompu après' }

/** The status line, announced on change only; the clock beside it ticks silently. @param {RunStatus} status */
function setStatus(status) {
  const box = $('runStatus')
  box.className = `run-status ${status}`
  box.replaceChildren(status === 'running' ? spinner() : icon(status === 'succeeded' ? 'check' : status === 'failed' || status === 'lost' ? 'x' : 'stop'),
    el('span', {}, STATUS_TEXT[status]), el('span', { className: 'run-time', 'aria-hidden': 'true' }, run ? clock(Date.now() - run.started) : ''),
    status === 'lost' ? el('span', {}, ' : le run continue sur le serveur.') : '')
  $('progress').hidden = status !== 'running'
}
const tick = () => { const t = $('runStatus').querySelector('.run-time'); if (t && run) t.textContent = clock(Date.now() - run.started) }

const stepsBox = () => /** @type {HTMLDetailsElement} */ ($('stepsBox'))

/** Puts the run view on screen for `r`. @param {ActiveRun} r */
function openRunView(r) {
  run = r
  $('runTitle').textContent = r.label
  $('runContext').replaceChildren(icon(/** @type {any} */ (r.target.context)), `${r.target.context === 'project' ? '' : `${refOf(r.target)} `}${r.title}`)
  $('steps').replaceChildren()
  stepsBox().open = true
  $('answers').replaceChildren()
  $('linkList').replaceChildren()
  $('links').hidden = true
  $('stop').hidden = false
  $('back').hidden = true
  show('running')
  setStatus('running')
  r.timer = setInterval(tick, 1000)
  $('runTitle').focus()
}

/** Launches `w` on the page the panel was showing, or on the pipeline picked for it. @param {Workflow} w @param {number} [pipelineId] */
async function launch(w, pipelineId) {
  const config = await getConfig()
  if (!config || !ctx || run || launching) return
  launching = true
  clearError()
  const instruction = /** @type {HTMLTextAreaElement} */ ($('instruction')).value.trim()
  // What the run is about: the page itself, or the pipeline picked on a merge request or project page.
  const target = w.context === 'pipeline' ? { context: 'pipeline', iid: pipelineId ?? ctx.iid } : ctx
  const body = {
    workflow: w.id, project: ctx.project,
    ...(w.context === 'merge_request' ? { mr_iid: ctx.iid } : w.context === 'issue' ? { issue_iid: ctx.iid } : w.context === 'pipeline' ? { pipeline_id: target.iid } : {}),
    ...(instruction ? { instruction } : {}),
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  // The run view opens on the click; the request fills in the run's id.
  /** @type {ActiveRun} */
  const r = { abort: new AbortController(), id: '', label: w.label, target, title: title || ctx.project, tabId: tab?.id, pageUrl: tab?.url, started: Date.now() }
  openRunView(r)
  step('Envoi de la demande')
  try {
    r.id = (await (await orchestrator(config, '/runs', { method: 'POST', body: JSON.stringify(body) })).json()).id
  } catch (e) {
    clearInterval(r.timer)
    run = null
    show('launch')
    return fail(e, () => launch(w, pipelineId))
  } finally {
    launching = false
  }
  /** @type {HTMLTextAreaElement} */ ($('instruction')).value = ''
  const { abort: _a, timer: _t, ...saved } = r
  await chrome.storage.session.set({ run: saved })
  await watch(config, r)
}

/** Follows run `r` to its end; `resumed` when the panel was reopened on it. @param {import('./api.js').Config} config @param {ActiveRun} r @param {boolean} [resumed] */
async function watch(config, r, resumed = false) {
  if (resumed) openRunView(r)
  step("Préparation de l'agent")
  // Set from the event callback, so held in an object (a plain `let` would be narrowed to its initial value).
  const result = { status: /** @type {RunStatus} */ ('stopped') }
  try {
    await followRun(config, r.id, ({ event, data }) => {
      if (event === 'end') result.status = data.status
      else if (event === 'error') { result.status = 'failed'; settle('error'); fail(data.error) }
      else if (event === 'waiting') detail(WAIT[/** @type {keyof typeof WAIT} */ (data.reason?.split(':')[0])] ?? data.reason)
      else if (data.event === 'tool_use') { const d = describeTool(data.name, data.input); step(d.text, d.detail) }
      else if (data.event === 'text') { settle('done'); answer(data.text) }
      else if (data.event === 'link') addLink(data)
      else if (data.event === 'error') { result.status = 'failed'; settle('error'); fail(data.message) }
      else if (data.event === 'workspace') step('Clonage du dépôt', data.branch)
    }, r.abort.signal)
  } catch (e) {
    // Lost the stream (network, expired session): the run itself goes on.
    if (!r.abort.signal.aborted) { result.status = 'lost'; fail(e) }
  }
  clearInterval(r.timer)
  settle(result.status === 'succeeded' ? 'done' : result.status === 'stopped' ? 'stopped' : 'error')
  setStatus(result.status)
  if (result.status !== 'lost') await chrome.storage.session.remove('run')
  $('stop').hidden = true
  $('back').hidden = false
  // The answer is what the user waited for: fold the steps away and bring it into view.
  const first = /** @type {HTMLElement | null} */ ($('answers').firstElementChild)
  if (first) { $('stepsSummary').textContent = `Étapes (${$('steps').childElementCount})`; stepsBox().open = false; first.focus(); first.scrollIntoView({ block: 'start' }) }
  else $('back').focus()
  // The agent wrote to GitLab: reload the page so the comment or MR shows up, if the tab is still on it.
  if (result.status === 'succeeded' && r.tabId && !$('linkList').childElementCount) {
    const tab = await chrome.tabs.get(r.tabId).catch(() => null)
    if (tab?.url === r.pageUrl) chrome.tabs.reload(r.tabId)
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────
$('settings').replaceChildren(icon('settings'))
$('stop').replaceChildren(icon('stop'), 'Arrêter')
$('logout').replaceChildren(icon('logout'), 'Se déconnecter')

$('stop').addEventListener('click', async () => {
  const config = await getConfig()
  if (!config || !run) return
  try { await orchestrator(config, `/runs/${run.id}/stop`, { method: 'POST' }) } catch (e) { fail(e) }
  run.abort.abort()
})
$('back').addEventListener('click', async () => { run = null; $('stepsSummary').textContent = 'Étapes'; await chrome.storage.session.remove('run'); refresh() })
$('retry').addEventListener('click', () => { clearError(); retry?.() })
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage())
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage())
$('login').addEventListener('click', async () => {
  const config = await getConfig()
  if (!config) return
  try { await login(config) } catch (e) { return fail(e) }
  refresh()
})
$('account').addEventListener('click', () => toggleMenu())
$('logout').addEventListener('click', async () => { toggleMenu(false); me = null; await logout(); refresh() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('menu').hidden) { toggleMenu(false); $('account').focus() } })
document.addEventListener('click', (e) => { if (!$('menu').hidden && !(/** @type {Node} */ (e.target)).parentElement?.closest('.bar-actions')) toggleMenu(false) })

chrome.tabs.onActivated.addListener(refresh)
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && info.url) refresh() })
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ('tokens' in changes || 'config' in changes)) refresh() })
refresh()
