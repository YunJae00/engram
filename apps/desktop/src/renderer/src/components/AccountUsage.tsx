import { LoaderCircle, RefreshCw } from 'lucide-react'
import { refreshAccountUsage, useAccountUsage, useAccountUsageChecking } from '../lib/accountUsage.js'
import type { DevUsage } from '../../../shared/developers.js'
import type { AccountProvider } from '../../../shared/account-profiles.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'

export function UsageSummary({ usage }: { usage: DevUsage | null }) {
  if (!usage) return <p className="setting-hint">Checking account limits…</p>
  return <div className="dev-usage">
    {usage.unavailable && <p className="setting-hint">{usage.unavailable}</p>}
    {usage.windows?.map((window, index) => <div key={`${window.name}-${index}`}>
      <div className="dev-usage-label"><span>{window.name}</span><span>{window.used === undefined ? 'Unavailable' : `${Math.round(100 - window.used)}% remaining`}</span></div>
      {window.used !== undefined && <progress max={100} value={100 - window.used} aria-label={`${window.name} remaining`} />}
      {window.resetsAt !== undefined && <small>Resets {new Date(window.resetsAt).toLocaleString('en-US')}</small>}
    </div>)}
    {usage.updatedAt && <small>Checked {new Date(usage.updatedAt).toLocaleTimeString('en-US')}</small>}
  </div>
}

export function AccountUsage({ provider }: { provider: AccountProvider }) {
  const accounts = useAccountUsage().filter(account => account.provider === provider), loading = useAccountUsageChecking(), profiles = useAccountProfiles()
  return <div className="account-usage">
    <div className="dev-usage-label"><strong>Accounts &amp; limits</strong><button className="dev-control" aria-label={`Refresh ${provider === 'claude' ? 'Claude' : 'ChatGPT'} usage`} disabled={loading} onClick={() => void refreshAccountUsage(true)}>{loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
    {!accounts.length && <p className="dev-working" role="status">{loading ? <><LoaderCircle size={14} className="spin" />Checking connected accounts…</> : 'Connect an AI account in settings to see its reported limits.'}</p>}
    {accounts.map(account => <section key={account.profile}><h4 className="dev-working">{account.name}{profiles?.selected[provider] === account.profile && <span className="account-selected">Selected</span>}</h4>{account.loading && !account.usage ? <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" />Checking limits…</p> : <UsageSummary usage={account.usage} />}</section>)}
  </div>
}
