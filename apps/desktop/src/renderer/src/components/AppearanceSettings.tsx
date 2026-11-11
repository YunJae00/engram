import type { AppSettingsDto } from '../../../shared/types.js'
import { t, type StringKey } from '../i18n.js'

const THEMES = [['system', 'settingsUi.themeSystem'], ['light', 'settingsUi.themeLight'], ['dark', 'settingsUi.themeDark']] as const satisfies readonly (readonly [string, StringKey])[]
const LANGUAGES = [['system', 'settingsUi.langSystem'], ['ko', 'settingsUi.langKo'], ['en', 'settingsUi.langEn']] as const satisfies readonly (readonly [string, StringKey])[]
type UiLanguage = NonNullable<AppSettingsDto['uiLanguage']>

// Three small windows to pick from; the one in use carries a soft ring.
export function AppearanceSettings({ value, onChange, disabled = false, language, onLanguage }: { value: AppSettingsDto['theme']; onChange: (theme: NonNullable<AppSettingsDto['theme']>) => void; disabled?: boolean; language?: AppSettingsDto['uiLanguage']; onLanguage?: (language: UiLanguage) => void }) {
  return <><fieldset className="appearance-settings" disabled={disabled}>
    <legend className="settings-hidden">{t('settingsUi.appearance')}</legend>
    <div className="appearance-options">{THEMES.map(([theme, nameKey]) => <label key={theme} className="appearance-option">
      <input type="radio" name="appearance" value={theme} checked={(value ?? 'system') === theme} onChange={() => onChange(theme)} />
      <span className={`appearance-preview appearance-${theme}`} aria-hidden><i /><span><i /><i /><i /></span></span>
      <span className="appearance-name">{t(nameKey)}</span>
    </label>)}</div>
  </fieldset>
  {onLanguage && <fieldset className="appearance-settings" disabled={disabled} style={{ marginTop: 16 }}>
    <legend className="settings-hidden">{t('settingsUi.language')}</legend>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>{LANGUAGES.map(([id, nameKey]) => <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      <input type="radio" name="ui-language" value={id} data-testid={`setting-ui-language-${id}`} aria-label={`${t('settingsUi.language')}: ${t(nameKey)}`} checked={(language ?? 'system') === id} onChange={() => onLanguage(id)} />
      <span>{t(nameKey)}</span>
    </label>)}</div>
  </fieldset>}</>
}
