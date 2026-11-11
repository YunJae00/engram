import { Settings, Brain, Database, Info, SlidersHorizontal } from 'lucide-react'
import { api } from '../api.js'
import { t } from '../i18n.js'

const SECTIONS = [
  { id: 'general', labelKey: 'settingsUi.general', icon: Settings },
  { id: 'ai', labelKey: 'settingsUi.ai', icon: Brain },
  { id: 'memory', labelKey: 'settingsUi.memory', icon: Database },
  { id: 'developers', labelKey: 'settingsUi.advanced', icon: SlidersHorizontal },
  { id: 'help', labelKey: 'settingsUi.about', icon: Info },
] as const
export type SettingsSection = typeof SECTIONS[number]['id']

export function SettingsNavigation({ selected = 'general', onSelect }: { selected?: SettingsSection; onSelect?: (section: SettingsSection) => void }) {
  return <nav className="settings-nav" aria-label={t('settingsUi.sections')}>
    {SECTIONS.filter(section => section.id !== 'developers' || api.developerUiEnabled).map(({ id, labelKey, icon: Icon }) => <button key={id} type="button" disabled={!onSelect} aria-current={selected === id ? 'page' : undefined} data-testid={`settings-nav-${id}`} onClick={() => onSelect?.(id)}><Icon size={17} aria-hidden /><span>{t(labelKey)}</span></button>)}
  </nav>
}
