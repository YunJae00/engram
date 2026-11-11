import { useId } from 'react'
import { t, type StringKey } from '../i18n.js'

// What Engram may learn from on this computer, each chosen on its own. The
// same list and words at onboarding and in Settings.
export type LearningKey = 'workMap' | 'workFiles' | 'workApps' | 'activity'
export type LearningChoice = Record<LearningKey, boolean>

export const LEARNING_SOURCES: { key: LearningKey; nameKey: StringKey; detailKey: StringKey }[] = [
  { key: 'workMap', nameKey: 'settingsUi.srcWorkMap', detailKey: 'settingsUi.srcWorkMapDetail' },
  { key: 'workFiles', nameKey: 'settingsUi.srcFiles', detailKey: 'settingsUi.srcFilesDetail' },
  { key: 'workApps', nameKey: 'settingsUi.srcApps', detailKey: 'settingsUi.srcAppsDetail' },
  { key: 'activity', nameKey: 'settingsUi.srcActivity', detailKey: 'settingsUi.srcActivityDetail' },
]
export const LEARNING_NOTE: StringKey = 'settingsUi.learnNoteLong'

export function LearningSources({ value, disabled, onChange, testPrefix, compact = false }: { value: LearningChoice; disabled?: boolean; onChange(key: LearningKey, on: boolean): void; testPrefix: string; compact?: boolean }) {
  const note = useId()
  return <fieldset className="learning-sources" aria-describedby={note} data-testid={`${testPrefix}-sources`}>
    <legend>{t('settingsUi.learnLegend')}</legend>
    {LEARNING_SOURCES.map(source => <label key={source.key} className={`learning-source${compact ? ' learning-source-compact' : ''}`} title={compact ? t(source.detailKey) : undefined}>
      <input type="checkbox" className={compact ? 'switch' : undefined} aria-description={compact ? t(source.detailKey) : undefined} data-testid={`${testPrefix}-source-${source.key}`} checked={value[source.key]} disabled={disabled} onChange={event => onChange(source.key, event.target.checked)} />
      <span><strong>{t(source.nameKey)}</strong>{!compact && <small>{t(source.detailKey)}</small>}</span>
    </label>)}
    <p className="setting-hint" id={note}>{t(compact ? 'settingsUi.learnCompact' : LEARNING_NOTE)}</p>
  </fieldset>
}
