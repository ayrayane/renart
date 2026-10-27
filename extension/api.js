// @ts-check
import { pkce, parseSSE } from './lib.js'

/** @typedef {{ gitlabUrl: string, orchestratorUrl: string, clientId: string }} Config */
/** @typedef {{ access_token: string, refresh_token: string, expires_at: number }} Tokens */

/** @returns {Promise<Config | null>} */
export async function getConfig() {
  /** @type {{ config?: Config }} */
  const { config } = await chrome.storage.local.get('config')
  return config?.gitlabUrl && config?.orchestratorUrl && config?.clientId ? config : null
}

const trimSlash = (/** @type {string} */ s) => s.replace(/\/$/, '')

/**
 * @param {Config} config
 * @param {Record<string, string>} params
 * @returns {Promise<Tokens>}
 */
async function tokenRequest(config, params) {
  const res = await fetch(`${trimSlash(config.gitlabUrl)}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, redirect_uri: chrome.identity.getRedirectURL(), ...params }),
  })
  if (!res.ok) throw new Error(`GitLab OAuth ${res.status}`)
  const t = await res.json()
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: (t.created_at + t.expires_in) * 1000 }
  await chrome.storage.local.set({ tokens })
  return tokens
}

/** GitLab OAuth, authorization code + PKCE (public client, no secret). @param {Config} config */
export async function login(config) {
  const { verifier, challenge } = await pkce()
  const state = crypto.randomUUID()
  const url = new URL(`${trimSlash(config.gitlabUrl)}/oauth/authorize`)
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: chrome.identity.getRedirectURL(), response_type: 'code',
    // read_api: Renart only reads as the user; everything it writes goes through its own account.
    scope: 'read_api', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  const redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true })
  const back = new URL(redirect ?? '')
  if (back.searchParams.get('state') !== state) throw new Error('OAuth state mismatch')
  const code = back.searchParams.get('code')
  if (!code) throw new Error(back.searchParams.get('error_description') ?? 'OAuth refused')
  const tokens = await tokenRequest(config, { grant_type: 'authorization_code', code, code_verifier: verifier })
  await chrome.storage.local.remove('expired')
  return tokens
}

export const logout = () => chrome.storage.local.remove('tokens')

/** A valid access token, refreshed when it expires within a minute; null when logged out. @param {Config} config */
export async function accessToken(config) {
  /** @type {{ tokens?: Tokens }} */
  const { tokens } = await chrome.storage.local.get('tokens')
  if (!tokens) return null
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token
  try {
    return (await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).access_token
  } catch {
    // Said on the sign-in screen, so the user knows why they are asked again.
    await chrome.storage.local.set({ expired: true })
    await logout()
    return null
  }
}

/**
 * Orchestrator call with the user's token; throws with the server's error message.
 * @param {Config} config
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function orchestrator(config, path, init = {}) {
  const token = await accessToken(config)
  if (!token) throw new Error('not logged in')
  const res = await fetch(`${trimSlash(config.orchestratorUrl)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `orchestrator ${res.status}`)
  return res
}

/**
 * Follows a run's events until the `end` event. A dropped stream is resumed after the last event received: on a
 * machine that is also a Kubernetes node, every new pod adds a network interface and Chrome resets its connections.
 * @param {Config} config
 * @param {string} id
 * @param {(e: { event: string, data: any }) => void} onEvent
 * @param {AbortSignal} signal
 */
export async function followRun(config, id, onEvent, signal) {
  let last = 0
  let failures = 0
  for (;;) {
    try {
      const res = await orchestrator(config, `/runs/${id}/events?after=${last}`, { signal })
      if (!res.body) throw new Error('no event stream')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        const { events, rest } = parseSSE(buffer + value)
        buffer = rest
        for (const e of events) {
          if (e.id) last = e.id
          failures = 0
          onEvent({ event: e.event, data: JSON.parse(e.data) })
          if (e.event === 'end') return
        }
      }
    } catch (err) {
      // Signed out: retrying cannot help.
      if (signal.aborted || /not logged in/.test(String(err)) || ++failures > 5) throw err
      await new Promise((r) => setTimeout(r, 1000 * failures))
    }
  }
}

/**
 * GitLab REST call with the user's token (page details, current user). Returns null when it fails: the panel works without.
 * @param {Config} config
 * @param {string} path
 */
export async function gitlabApi(config, path) {
  const token = await accessToken(config)
  if (!token) return null
  const res = await fetch(`${trimSlash(config.gitlabUrl)}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
  // A revoked token: sign out, the panel then asks to sign in again.
  if (res?.status === 401) { await chrome.storage.local.set({ expired: true }); await logout() }
  return res?.ok ? res.json() : null
}
