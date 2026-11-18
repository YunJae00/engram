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

export function usageLabel(name: string): string {
  return name === 'System account' ? t('model.systemAccount') : name === '5-hour limit' ? t('model.limit5h') : name === 'Weekly limit' ? t('model.limitWeekly') : name
}

export function visibleLoginMessage(connected: boolean, message?: string): string | undefined {
  return connected || !message ? undefined : message
}

export function filingRetryShown(state: { paused: boolean; retrying: boolean }): boolean {
  return state.paused || state.retrying
}
