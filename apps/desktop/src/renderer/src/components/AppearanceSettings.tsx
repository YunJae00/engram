import type { AppSettingsDto } from '../../../shared/types.js'
import { t, type StringKey } from '../i18n.js'

const THEMES = [['system', 'settingsUi.themeSystem'], ['light', 'settingsUi.themeLight'], ['dark', 'settingsUi.themeDark']] as const satisfies readonly (readonly [string, StringKey])[]

export function AppearanceSettings({ value, onChange, disabled = false }: { value: AppSettingsDto['theme']; onChange: (theme: NonNullable<AppSettingsDto['theme']>) => void; disabled?: boolean }) {
  return <fieldset className="appearance-settings" disabled={disabled}>
    <legend className="settings-hidden">{t('settingsUi.appearance')}</legend>
    <div className="appearance-options">{THEMES.map(([theme, nameKey]) => <label key={theme} className="appearance-option">
      <input type="radio" name="appearance" value={theme} checked={(value ?? 'system') === theme} onChange={() => onChange(theme)} />
      <span className={`appearance-preview appearance-${theme}`} aria-hidden><i /><span><i /><i /><i /></span></span>
      <span className="appearance-name">{t(nameKey)}</span>
    </label>)}</div>
  </fieldset>
}
