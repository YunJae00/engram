import type { EngineHealthReason } from './types.js'

export type AccountProvider = 'claude' | 'codex'
export interface AccountProfileState { id: string; provider: AccountProvider; name: string; selected: boolean; installed: boolean; loggedIn: boolean; conclusive?: boolean; healthy?: boolean; healthReason?: EngineHealthReason }
export interface AccountProfiles {
  profiles: { id: string; provider: AccountProvider; name: string }[]
  selected: Record<AccountProvider, string>
}
