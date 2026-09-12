import { t } from '../i18n.js'
import { DialogHeader } from './DialogHeader.js'
import { SettingsNavigation } from './SettingsNavigation.js'

export function SettingsLoading({ failed, onClose, onRetry }: { failed: boolean; onClose(): void; onRetry(): void }) {
  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box settings-box" data-testid="settings-loading" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('settings.title')} aria-modal="true">
        <DialogHeader closeLabel={t('settings.cancel')} onClose={onClose}>{t('settings.title')}</DialogHeader>
        <div className="settings-body">
        <SettingsNavigation />
        <div className="settings-scroll" aria-busy={!failed}>
          {failed ? <div className="settings-load-error" role="alert"><p>{t('settings.loadFailed')}</p><button className="secondary" onClick={onRetry}>{t('settings.retry')}</button></div> : (
            <div className="settings-skeleton" role="status" aria-label={t('settings.loading')}>
              {Array.from({ length: 7 }, (_, index) => (
                <div key={index} className="settings-skeleton-row" aria-hidden="true">
                  <span className="skeleton-line" style={{ width: `${28 + ((index * 17) % 30)}%` }} />
                  <span className="skeleton-line short" />
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
