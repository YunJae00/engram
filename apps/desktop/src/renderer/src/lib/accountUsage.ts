import { useSyncExternalStore } from 'react'
import type { DevProvider, DevUsage } from '../../../shared/developers.js'
import { api } from '../api.js'

type Account = { provider: DevProvider; usage: DevUsage | null; loading: boolean }
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
    const states = await api.engineStates()
    accounts = states.filter(state => state.loggedIn && (state.id === 'claude' || state.id === 'codex')).map(state => ({ provider: state.id as DevProvider, usage: accounts.find(account => account.provider === state.id)?.usage ?? null, loading: true }))
    emit()
    await Promise.all(accounts.map(async ({ provider }) => {
      let usage: DevUsage
      try { usage = await api.devUsage(provider) }
      catch { usage = { unavailable: 'Account limits could not be refreshed. Try again later.' } }
      accounts = accounts.map(account => account.provider === provider ? { provider, usage: { ...usage, updatedAt: usage.updatedAt ?? Date.now() }, loading: false } : account)
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
    if (['engines:detected', 'engines:changed', 'engines:login'].includes(event.type)) { checked = 0; if (!document.hidden) void refreshAccountUsage(true) }
    if (event.type === 'dev:changed' && event.update?.state === 'idle') refresh()
  })
  return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); off() }
}
