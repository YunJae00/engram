import { LoaderCircle, RefreshCw } from 'lucide-react'
import { refreshAccountUsage, useAccountUsage, useAccountUsageChecking } from '../lib/accountUsage.js'
import type { DevUsage } from '../../../shared/developers.js'
import type { AccountProvider } from '../../../shared/account-profiles.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { t, uiLocale } from '../i18n.js'

const valid = (date: Date): Date | undefined => (Number.isFinite(date.getTime()) ? date : undefined)

export function UsageSummary({ usage }: { usage: DevUsage | null }) {
  if (!usage) return <p className="setting-hint">{t('settingsUi.checkingAccountLimits')}</p>
  return <div className="dev-usage">
    {usage.unavailable && <p className="setting-hint">{usage.unavailable}</p>}
    {usage.windows?.map((window, index) => { const resets = window.resetsAt === undefined ? undefined : valid(new Date(window.resetsAt)); return <div key={`${window.name}-${index}`}>
      <div className="dev-usage-label"><span>{window.name}</span><span>{window.used === undefined ? t('model.limitUnavailable') : t('settingsUi.percentRemaining', { percent: Math.round(100 - window.used) })}</span></div>
      {window.used !== undefined && <progress max={100} value={100 - window.used} aria-label={t('settingsUi.windowRemaining', { name: window.name })} />}
      {resets && <small>{t('settingsUi.resets', { time: resets.toLocaleString(uiLocale()) })}</small>}
    </div> })}
    {usage.updatedAt && valid(new Date(usage.updatedAt)) && <small>{t('settingsUi.checked', { time: new Date(usage.updatedAt).toLocaleTimeString(uiLocale()) })}</small>}
  </div>
}

export function AccountUsage({ provider, verified = true }: { provider: AccountProvider; verified?: boolean }) {
  const accounts = useAccountUsage().filter(account => verified && account.provider === provider), loading = useAccountUsageChecking(), profiles = useAccountProfiles()
  return <div className="account-usage">
    <div className="dev-usage-label"><strong>{t('settingsUi.usageLimits')}</strong><button className="dev-control" aria-label={t('settingsUi.refreshUsage', { provider: provider === 'claude' ? 'Claude' : 'ChatGPT' })} disabled={loading} onClick={() => void refreshAccountUsage(true)}>{loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
    {!accounts.length && <p className="dev-working" role="status">{loading && verified ? <><LoaderCircle size={14} className="spin" />{t('settingsUi.checkingConnected')}</> : t('settingsUi.connectToSeeLimits')}</p>}
    {accounts.map(account => <section key={account.profile}><h4 className="dev-working">{account.name}{profiles?.selected[provider] === account.profile && <span className="account-selected">{t('settingsUi.selected')}</span>}</h4>{account.loading && !account.usage ? <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" />{t('model.checkingLimits')}</p> : <UsageSummary usage={account.usage} />}</section>)}
  </div>
}
