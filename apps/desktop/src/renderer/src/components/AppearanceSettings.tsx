import type { AppSettingsDto } from '../../../shared/types.js'

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const

// Three small windows to pick from; the one in use carries a soft ring.
export function AppearanceSettings({ value, onChange, disabled = false }: { value: AppSettingsDto['theme']; onChange: (theme: NonNullable<AppSettingsDto['theme']>) => void; disabled?: boolean }) {
  return <fieldset className="appearance-settings" disabled={disabled}>
    <legend className="settings-hidden">Appearance</legend>
    <div className="appearance-options">{THEMES.map(([theme, name]) => <label key={theme} className="appearance-option">
      <input type="radio" name="appearance" value={theme} checked={(value ?? 'system') === theme} onChange={() => onChange(theme)} />
      <span className={`appearance-preview appearance-${theme}`} aria-hidden><i /><span><i /><i /><i /></span></span>
      <span className="appearance-name">{name}</span>
    </label>)}</div>
  </fieldset>
}
