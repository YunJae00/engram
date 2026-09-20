import { useSyncExternalStore } from 'react'
import type { DevProvider, DevUsage } from '../../../shared/developers.js'
import { api } from '../api.js'

type Account = { provider: DevProvider; profile: string; name: string; usage: DevUsage | null; loading: boolean }
let accounts: Account[] = []
let pending: Promise<void> | undefined
let checked = 0
let refreshAgain = false
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useAccountUsage = () => useSyncExternalStore(subscribe, () => accounts)
export const useAccountUsageChecking = () => useSyncExternalStore(subscribe, () => pending !== undefined)

export function refreshAccountUsage(force = false): Promise<void> {
  if (pending) { if (force) refreshAgain = true; return pending }
  if (!force && Date.now() - checked < 60_000) return Promise.resolve()
  checked = Date.now()
  pending = (async () => {
    const profiles = await api.accountProfiles()
    const states = profiles.profiles.length ? await api.accountProfileStates() : (await api.engineStates()).filter(state => state.id === 'claude' || state.id === 'codex').map(state => ({ ...state, provider: state.id as DevProvider, id: 'system', name: 'System account' }))
    accounts = states.filter(state => state.loggedIn).map(state => ({ provider: state.provider, profile: state.id, name: state.name, usage: accounts.find(account => account.provider === state.provider && account.profile === state.id)?.usage ?? null, loading: true }))
    emit()
    const work = [...accounts]
    for (let at = 0; at < work.length; at += 2) await Promise.all(work.slice(at, at + 2).map(async ({ provider, profile }) => {
      let usage: DevUsage
      try { usage = await api.devUsage(provider, profile) }
      catch { usage = { unavailable: 'Account limits could not be refreshed. Try again later.' } }
      accounts = accounts.map(account => account.provider === provider && account.profile === profile ? { ...account, usage: { ...usage, updatedAt: usage.updatedAt ?? Date.now() }, loading: false } : account)
      emit()
    }))
  })().catch(() => { accounts = accounts.map(account => ({ ...account, loading: false })); emit() }).finally(() => {
    pending = undefined
    emit()
    if (refreshAgain) { refreshAgain = false; void refreshAccountUsage(true) }
  })
  emit()
  return pending
}

export function watchAccountUsage(): () => void {
  const refresh = () => { if (!document.hidden) void refreshAccountUsage() }
  refresh()
  const timer = window.setInterval(refresh, 60_000)
  document.addEventListener('visibilitychange', refresh)
  const off = api.onEvent(event => {
    if (['engines:detected', 'engines:changed', 'engines:login', 'accounts:changed'].includes(event.type)) { checked = 0; if (!document.hidden) void refreshAccountUsage(true) }
    if (event.type === 'dev:changed' && event.update?.usage.windows?.length) {
      const { provider, usage, accountProfile = 'system' } = event.update
      if (accounts.some(account => account.provider === provider && account.profile === accountProfile && (usage.updatedAt ?? 0) > (account.usage?.updatedAt ?? 0))) {
        accounts = accounts.map(account => account.provider === provider && account.profile === accountProfile ? { ...account, usage } : account)
        emit()
      }
    }
    if (event.type === 'dev:changed' && event.update?.state === 'idle') refresh()
  })
  return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); off() }
}
