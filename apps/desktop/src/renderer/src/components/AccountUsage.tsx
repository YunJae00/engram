import type { DevUsage } from '../../../shared/developers.js'
import { t, uiLocale } from '../i18n.js'
import { usageLabel } from '../lib/connectionStatus.js'

const valid = (date: Date): Date | undefined => (Number.isFinite(date.getTime()) ? date : undefined)

export function UsageSummary({ usage }: { usage: DevUsage | null }) {
  if (!usage) return <p className="setting-hint">{t('settingsUi.checkingAccountLimits')}</p>
  return <div className="dev-usage">
    {usage.unavailable && <p className="setting-hint">{usage.unavailable}</p>}
    {usage.windows?.map((window, index) => { const resets = window.resetsAt === undefined ? undefined : valid(new Date(window.resetsAt)); return <div key={`${window.name}-${index}`}>
      <div className="dev-usage-label"><span>{usageLabel(window.name)}</span><span>{window.used === undefined ? t('model.limitUnavailable') : t('settingsUi.percentRemaining', { percent: Math.round(100 - window.used) })}</span></div>
      {window.used !== undefined && <progress max={100} value={100 - window.used} aria-label={t('settingsUi.windowRemaining', { name: usageLabel(window.name) })} />}
      {resets && <small>{t('settingsUi.resets', { time: resets.toLocaleString(uiLocale()) })}</small>}
    </div> })}
    {usage.updatedAt && valid(new Date(usage.updatedAt)) && <small>{t('settingsUi.checked', { time: new Date(usage.updatedAt).toLocaleTimeString(uiLocale()) })}</small>}
  </div>
}

