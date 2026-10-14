import type { EngineStatusDto } from '../../../shared/types.js'

type Connection = Pick<EngineStatusDto, 'installed' | 'loggedIn' | 'conclusive' | 'healthy' | 'healthReason'>
export function connectionConfirmed(state: Connection | undefined): boolean {
  return !!state?.installed && state.loggedIn && state.conclusive !== false && !(state.healthy === false && state.healthReason === 'auth')
}
export function connectionLabel(state: Connection | undefined, provider: string): string {
  if (!state) return 'Checking connection…'
  if (state.healthy === false && state.healthReason === 'auth') return 'Reconnect required'
  if (state.conclusive === false) return 'Connection not verified'
  if (!state.installed) return provider === 'claude' ? 'Not installed' : 'Runtime unavailable'
  if (!state.loggedIn) return 'Not connected'
  if (state.healthy === false) return state.healthReason === 'quota' ? 'Usage limit reached' : 'Connection needs attention'
  return 'Connected'
}
