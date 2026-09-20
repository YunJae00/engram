import { useEffect, useState } from 'react'
import type { AccountProfiles } from '../../../shared/account-profiles.js'
import { api } from '../api.js'

export function useAccountProfiles() {
  const [profiles, setProfiles] = useState<AccountProfiles | null>(null)
  useEffect(() => {
    let alive = true, revision = 0
    void api.accountProfiles().then(value => { if (alive && !revision) setProfiles(value) }).catch(() => {})
    const off = api.onEvent(event => { if (event.type === 'accounts:changed') { revision++; setProfiles(event.accounts) } })
    return () => { alive = false; off() }
  }, [])
  return profiles
}
