import { t } from '../i18n.js'
import type { EngineStatusDto } from '../../../shared/types.js'

type Connection = Pick<EngineStatusDto, 'installed' | 'loggedIn' | 'conclusive' | 'healthy' | 'healthReason'>
export function connectionConfirmed(state: Connection | undefined): boolean {
  return !!state?.installed && state.loggedIn && state.conclusive !== false && !(state.healthy === false && state.healthReason === 'auth')
}
export function connectionLabel(state: Connection | undefined, provider: string): string {
  if (!state) return t('connection.checking')
  if (!state.installed && state.conclusive !== false) return provider === 'claude' ? t('connection.notInstalled') : t('connection.runtimeUnavailable')
  if (state.healthy === false && state.healthReason === 'auth') return t('connection.reconnect')
  if (state.conclusive === false) return t('connection.unverified')
  if (!state.loggedIn) return t('connection.notConnected')
  if (state.healthy === false) return state.healthReason === 'quota' ? t('connection.limited') : state.healthReason === 'outage' ? t('connection.outage') : t('connection.attention')
  return t('connection.connected')
}

// A finished external sign-in replaces an earlier browser failure. The old
// sentence stays in the login record until the next attempt; it is not the
// current account state.
export function visibleLoginMessage(connected: boolean, message?: string): string | undefined {
  return connected || !message ? undefined : message
}
