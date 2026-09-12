import { Check } from 'lucide-react'
import type { AppSettingsDto } from '../../../shared/types.js'

export function AppearanceSettings({ value, onChange }: { value: AppSettingsDto['theme']; onChange: (theme: NonNullable<AppSettingsDto['theme']>) => void }) {
  return <fieldset className="appearance-settings">
    <legend>Appearance</legend>
    <div className="appearance-options">{(['system', 'light', 'dark'] as const).map((theme) => <label key={theme} className="appearance-option">
      <input type="radio" name="appearance" value={theme} checked={(value ?? 'system') === theme} onChange={() => onChange(theme)} />
      <span className={`appearance-preview appearance-${theme}`} aria-hidden><i /><span><i /><i /><i /></span><Check size={16} /></span>
      <span>{theme === 'system' ? 'Use system setting' : theme === 'light' ? 'Light' : 'Dark'}</span>
    </label>)}</div>
  </fieldset>
}
