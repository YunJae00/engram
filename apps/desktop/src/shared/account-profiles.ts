export type AccountProvider = 'claude' | 'codex'
export interface AccountProfiles {
  profiles: { id: string; provider: AccountProvider; name: string }[]
  selected: Record<AccountProvider, string>
}
