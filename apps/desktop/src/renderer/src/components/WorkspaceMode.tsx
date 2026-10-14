import { Code2 } from 'lucide-react'
import { Comet } from './Icon.js'
import { api } from '../api.js'

export function WorkspaceMode({ developer, onChange }: { developer: boolean; onChange(mode: 'bots' | 'developers'): void }) {
  if (!api.developerUiEnabled) return null
  return <div className="workspace-mode-toggle" role="group" aria-label="Workspace mode">
    <button data-testid="mode-bots" aria-label="Comets mode" title="Comets" aria-pressed={!developer} onClick={() => onChange('bots')}><Comet size={16} /></button>
    {api.developerUiEnabled && <button data-testid="activity-developers" aria-label="Developers mode" title="Developers" aria-pressed={developer} onClick={() => onChange('developers')}><Code2 size={16} aria-hidden /></button>}
  </div>
}
