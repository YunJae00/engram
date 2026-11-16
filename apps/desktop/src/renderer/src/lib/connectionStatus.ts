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

// The main process names the system account and Claude's two limit windows in English; the UI says them in its language.
// Any other name (a profile the person named, a provider's own limit name) is shown as it is.
export function usageLabel(name: string): string {
  return name === 'System account' ? t('model.systemAccount') : name === '5-hour limit' ? t('model.limit5h') : name === 'Weekly limit' ? t('model.limitWeekly') : name
}

// A finished external sign-in replaces an earlier browser failure. The old
// sentence stays in the login record until the next attempt; it is not the
// current account state.
export function visibleLoginMessage(connected: boolean, message?: string): string | undefined {
  return connected || !message ? undefined : message
}

// The footer's retry button is for a filing that stopped short (and stays, disabled, while that retry runs); with nothing to retry it is not shown.
export function filingRetryShown(state: { paused: boolean; retrying: boolean }): boolean {
  return state.paused || state.retrying
}
