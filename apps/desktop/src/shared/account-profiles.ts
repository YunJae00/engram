export type AccountProvider = 'claude' | 'codex'
export interface AccountProfileState { id: string; provider: AccountProvider; name: string; selected: boolean; installed: boolean; loggedIn: boolean; conclusive?: boolean }
export interface AccountProfiles {
  profiles: { id: string; provider: AccountProvider; name: string }[]
  selected: Record<AccountProvider, string>
}
