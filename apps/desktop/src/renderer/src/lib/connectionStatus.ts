import type { EngineStatusDto } from '../../../shared/types.js'

type Connection = Pick<EngineStatusDto, 'installed' | 'loggedIn' | 'conclusive' | 'healthy' | 'healthReason'>
export function connectionConfirmed(state: Connection | undefined): boolean {
  return !!state?.installed && state.loggedIn && state.conclusive !== false && !(state.healthy === false && state.healthReason === 'auth')
}
export function connectionLabel(state: Connection | undefined, provider: string): string {
  if (!state) return 'Checking connection…'
  if (!state.installed && state.conclusive !== false) return provider === 'claude' ? 'Not installed' : 'Runtime unavailable'
  if (state.healthy === false && state.healthReason === 'auth') return 'Reconnect required'
  if (state.conclusive === false) return 'Connection not verified'
  if (!state.loggedIn) return 'Not connected'
  if (state.healthy === false) return state.healthReason === 'quota' ? 'Request limited · Retry check' : state.healthReason === 'outage' ? 'Not answering on its side' : 'Connection needs attention'
  return 'Connected'
}
