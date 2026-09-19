import { Settings, Brain, Monitor, Database, Info, CircleHelp, Code2 } from 'lucide-react'

const SECTIONS = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'ai', label: 'AI connection', icon: Brain },
  { id: 'computer', label: 'Computer use', icon: Monitor },
  { id: 'developers', label: 'Developers', icon: Code2 },
  { id: 'memory', label: 'Memory & data', icon: Database },
  { id: 'about', label: 'About', icon: Info },
  { id: 'help', label: 'Help', icon: CircleHelp },
] as const
export type SettingsSection = typeof SECTIONS[number]['id']

export function SettingsNavigation({ selected = 'general', onSelect }: { selected?: SettingsSection; onSelect?: (section: SettingsSection) => void }) {
  return <nav className="settings-nav" aria-label="Settings sections">
    {SECTIONS.map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={!onSelect} aria-current={selected === id ? 'page' : undefined} data-testid={`settings-nav-${id}`} onClick={() => onSelect?.(id)}><Icon size={17} aria-hidden /><span>{label}</span></button>)}
  </nav>
}
