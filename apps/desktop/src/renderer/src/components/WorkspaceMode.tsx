import { Code2 } from 'lucide-react'
import { Comet } from './Icon.js'

export function WorkspaceMode({ developer, onChange }: { developer: boolean; onChange(mode: 'bots' | 'developers'): void }) {
  return <div className="workspace-mode-toggle" role="group" aria-label="Workspace mode">
    <button data-testid="activity-bots" aria-label="Comets mode" title="Comets" aria-pressed={!developer} onClick={() => onChange('bots')}><Comet size={16} /></button>
    <button data-testid="activity-developers" aria-label="Developers mode" title="Developers" aria-pressed={developer} onClick={() => onChange('developers')}><Code2 size={16} aria-hidden /></button>
  </div>
}
