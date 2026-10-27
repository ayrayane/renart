// @ts-check
import { gitlabBase } from './lib.js'
const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id))
const fields = ['gitlabUrl', 'orchestratorUrl', 'clientId']

$('redirect').textContent = chrome.identity.getRedirectURL()
$('copy').addEventListener('click', () => navigator.clipboard.writeText(chrome.identity.getRedirectURL()).then(() => { $('copy').textContent = 'Copiée' }))
chrome.storage.local.get('config').then((/** @type {{ config?: Record<string, string> }} */ { config }) => {
  for (const f of fields) $(f).value = config?.[f] ?? ''
})

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const config = Object.fromEntries(fields.map((f) => [f, $(f).value.trim().replace(/\/$/, '')]))
  config.gitlabUrl = gitlabBase(config.gitlabUrl)
  const say = (/** @type {string} */ text) => { $('status').textContent = text }
  if (!config.clientId) return say("Renseignez l'Application ID.")
  for (const f of ['gitlabUrl', 'orchestratorUrl']) {
    // Tokens travel to both: never in clear.
    if (!/^https:\/\/[^/]+/.test(config[f])) return say(`${f === 'gitlabUrl' ? "L'URL de GitLab" : "L'URL de l'orchestrateur"} doit commencer par https://.`)
  }
  // Host access is asked for these two origins only, from this click (a user gesture is required).
  const origins = [config.gitlabUrl, config.orchestratorUrl].map((u) => `${new URL(u).origin}/*`)
  const granted = await chrome.permissions.request({ origins })
  if (!granted) {
    $('status').textContent = "Accès refusé : Renart ne peut pas joindre GitLab ni l'orchestrateur sans cette permission."
    return
  }
  // Checked before anything is saved: a typo here would only show later, as a vague error in the panel.
  const reachable = await fetch(`${config.orchestratorUrl}/healthz`).then((r) => r.ok, () => false)
  if (!reachable) return say("L'orchestrateur ne répond pas à cette adresse. Vérifiez l'URL, ou qu'il tourne.")
  /** @type {{ config?: Record<string, string> }} */
  const { config: before } = await chrome.storage.local.get('config')
  await chrome.storage.local.set({ config })
  // Only a changed GitLab or client id invalidates the login.
  if (before?.gitlabUrl !== config.gitlabUrl || before?.clientId !== config.clientId) await chrome.storage.local.remove('tokens')
  $('status').textContent = 'Enregistré. Retour sur GitLab…'
  // Back to GitLab, Renart's panel open on it to sign in: an open GitLab tab if there is one (this one closes), else this tab.
  const [gitlabTab] = await chrome.tabs.query({ url: `${new URL(config.gitlabUrl).origin}/*` })
  const self = await chrome.tabs.getCurrent()
  const target = gitlabTab ?? self
  if (!target?.id) return void (location.href = config.gitlabUrl)
  // Opening the panel needs the click's user gesture, still alive here; where it has expired the panel stays one click away.
  await chrome.sidePanel.open({ tabId: target.id }).catch(() => {})
  if (gitlabTab?.id) {
    await chrome.tabs.update(gitlabTab.id, { active: true })
    if (self?.id) chrome.tabs.remove(self.id)
  } else location.href = config.gitlabUrl
})
