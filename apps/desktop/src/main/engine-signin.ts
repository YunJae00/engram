import { shell } from 'electron'
import { cloudEngine, type CloudEngineId } from './engine-cloud.js'
import { broadcast } from './engine-health.js'
import type { EngineLoginDto } from '../shared/types.js'
import { activeAccountProfile } from './account-profiles.js'

type Login = { state: EngineLoginDto; abort: AbortController; url?: string; result?: Promise<{ ok: boolean; message?: string }> }
const logins = new Map<string, Login>()
const loginKey = (id: CloudEngineId, profile: string) => `${id}:${profile}`

export function loginUrl(id: CloudEngineId, value: string): string | undefined {
  try {
    const url = new URL(value)
    const allowed = id === 'codex' ? ['auth.openai.com'] : ['claude.ai', 'console.anthropic.com', 'platform.claude.com']
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.includes(url.hostname) || !/\/oauth\/authorize\/?$/.test(url.pathname)) return
    return url.href
  } catch { return }
}

export function engineLogins(): EngineLoginDto[] { return [...logins.values()].map((login) => login.state) }
function publish(login: Login, phase: EngineLoginDto['phase'], message?: string): void {
  login.state = { id: login.state.id, profile: login.state.profile, phase, canOpen: phase === 'browser' && !!login.url, ...(message ? { message } : {}) }
  broadcast({ type: 'engines:login', login: login.state })
}
export async function reopenEngineLogin(id: CloudEngineId, profile = activeAccountProfile(id)): Promise<void> {
  const login = logins.get(loginKey(id, profile))
  if (login?.state.phase !== 'browser' || !login.url) return
  await shell.openExternal(login.url)
}
export function cancelEngineLogin(id: CloudEngineId, profile = activeAccountProfile(id)): void {
  const login = logins.get(loginKey(id, profile))
  if (!login?.result) return
  login.abort.abort()
  login.url = undefined
  publish(login, 'idle')
}
export async function disconnectEngine(id: CloudEngineId, profile = activeAccountProfile(id)): Promise<void> {
  cancelEngineLogin(id, profile)
  await logins.get(loginKey(id, profile))?.result
  await cloudEngine(id, profile).logout()
  const login = logins.get(loginKey(id, profile))
  logins.delete(loginKey(id, profile))
  if (login) publish(login, 'idle')
}
export function connectEngine(id: CloudEngineId, profile = activeAccountProfile(id)): Promise<{ ok: boolean; message?: string }> {
  const previous = logins.get(loginKey(id, profile))
  if (previous?.result) return previous.result
  if ([...logins.values()].some(login => login.state.id === id && login.result)) return Promise.resolve({ ok: false, message: 'Finish or cancel the other sign-in for this provider first.' })
  const login: Login = { state: { id, profile, phase: 'opening', canOpen: false }, abort: new AbortController() }
  logins.set(loginKey(id, profile), login)
  publish(login, 'opening')
  login.result = cloudEngine(id, profile).login({ signal: login.abort.signal, onUrl: (value) => {
    if (login.abort.signal.aborted) return
    const url = loginUrl(id, value)
    if (!url || url === login.url) return
    login.url = url
    publish(login, 'browser')
    // This runtime delegates browser presentation to its host. The other
    // runtime opens its own browser; the same link remains available to retry.
    if (id === 'codex') void reopenEngineLogin(id, profile).catch(() => {
      if (!login.abort.signal.aborted && login.state.phase === 'browser') publish(login, 'browser', 'The browser did not open. Use Open browser to try again.')
    })
  } }).then((result) => {
    if (login.abort.signal.aborted) return { ok: false }
    publish(login, result.ok ? 'connected' : 'error', result.message)
    return result
  }).catch(() => {
    const message = login.abort.signal.aborted ? undefined : 'Sign-in did not finish. Try again in your browser.'
    publish(login, message ? 'error' : 'idle', message)
    return { ok: false, message }
  }).finally(() => { login.url = undefined; login.result = undefined })
  return login.result
}
