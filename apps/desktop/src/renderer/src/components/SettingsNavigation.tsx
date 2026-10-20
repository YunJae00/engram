import { Settings, Brain, Database, Info, SlidersHorizontal } from 'lucide-react'
import { api } from '../api.js'

const SECTIONS = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'ai', label: 'AI & accounts', icon: Brain },
  { id: 'memory', label: 'Memory & data', icon: Database },
  { id: 'developers', label: 'Advanced', icon: SlidersHorizontal },
  { id: 'help', label: 'About', icon: Info },
] as const
export type SettingsSection = typeof SECTIONS[number]['id']

export function SettingsNavigation({ selected = 'general', onSelect }: { selected?: SettingsSection; onSelect?: (section: SettingsSection) => void }) {
  return <nav className="settings-nav" aria-label="Settings sections">
    {SECTIONS.filter(section => section.id !== 'developers' || api.developerUiEnabled).map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={!onSelect} aria-current={selected === id ? 'page' : undefined} data-testid={`settings-nav-${id}`} onClick={() => onSelect?.(id)}><Icon size={17} aria-hidden /><span>{label}</span></button>)}
  </nav>
}
