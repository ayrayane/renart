// @ts-check
// DOM helpers and icons for the panel. Text always goes in through textContent / text nodes, never HTML.

// 16×16 stroked icons in the spirit of GitLab's set (static paths, 24-unit viewBox).
export const ICONS = {
  merge_request: 'M6 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 8v8M6 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 16V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
  issue: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 12h.01',
  project: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM4 17a2 2 0 0 1 2-2h12',
  review: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  summary: 'M5 6h14M5 10h14M5 14h9M5 18h6',
  plan: 'M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17',
  branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  pipeline: 'M5 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM19 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7.5 12h2M14.5 12h2',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9',
  shield: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6zM9 12l2 2 4-4',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  ci_failed: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  chevron: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  stop: 'M7 7h10v10H7z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  comment: 'M4 5h16v11H9l-5 4z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-1-3-2 .2-1.3-1.3L17 5l-3-1-1 2h-2l-1-2-3 1 .2 2L5.9 8.2 4 8l-1 3 2 1v0l-2 1 1 3 2-.2 1.3 1.3L7 19l3 1 1-2h2l1 2 3-1-.2-2 1.3-1.3 2 .2 1-3z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  send: 'M5 12h14M13 6l6 6-6 6',
}

/** @param {keyof typeof ICONS} name @param {string} [className] */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [props] className, attributes (aria-*, data-*) or DOM properties
 * @param {(string | Node | null | undefined | false)[]} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role') node.setAttribute(k, String(v))
    else /** @type {any} */ (node)[k] = v
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}

/** Spinner that respects reduced motion (CSS). */
export const spinner = () => el('span', { className: 'spinner', 'aria-hidden': 'true' })

/** mm:ss */
export const clock = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Readable message for errors coming back from the orchestrator or the network. @param {unknown} e */
export function humanError(e) {
  const msg = e instanceof Error ? e.message : String(e)
  if (/cannot access this project/.test(msg)) return "Votre compte GitLab n'a pas accès à ce projet."
  if (/Developer role required/.test(msg)) return 'Il faut le rôle Developer sur ce projet pour lancer une action.'
  if (/Renart account is not a member/.test(msg)) return "Le compte Renart n'est pas membre de ce projet : ajoutez-le comme Developer pour l'utiliser ici."
  if (/not logged in|401/.test(msg)) return 'Votre session GitLab a expiré. Reconnectez-vous.'
  if (/did not approve|user cancel/i.test(msg)) return 'Connexion annulée.'
  if (/Authorization page could not be loaded|could not be loaded/i.test(msg)) return "La page de connexion GitLab ne s'ouvre pas : vérifiez l'URL GitLab et l'Application ID dans les options."
  if (/too many runs in progress/.test(msg)) return `Vous avez déjà ${msg.match(/max (\d+)/)?.[1] ?? 'trop de'} runs en cours : attendez qu'un se termine.`
  if (/audit log unavailable/.test(msg)) return "Le journal d'audit de Renart est indisponible : les lancements sont suspendus. Prévenez l'administrateur."
  if (/Failed to fetch|NetworkError|network error|50[234]/.test(msg)) return "L'orchestrateur Renart ne répond pas. Vérifiez qu'il tourne, puis réessayez."
  if (/needs (mr_iid|issue_iid|pipeline_id)/.test(msg)) return "Cette action ne s'applique pas à cette page."
  if (/ran on a tag/.test(msg)) return "Cette pipeline a tourné sur un tag : il n'y a pas de branche à corriger."
  if (/from a fork/.test(msg)) return "Les merge requests venant d'un fork ne sont pas encore prises en charge."
  return msg
}
