import { Code2, MessageSquare } from 'lucide-react'

export function WorkspaceMode({ developer, onChange }: { developer: boolean; onChange(mode: 'bots' | 'developers'): void }) {
  return <div className="workspace-mode-toggle" role="group" aria-label="Workspace mode">
    <button aria-label="Chat mode" title="Chat" aria-pressed={!developer} onClick={() => onChange('bots')}><MessageSquare size={16} /></button>
    <button aria-label="Developers mode" title="Developers" aria-pressed={developer} onClick={() => onChange('developers')}><Code2 size={16} /></button>
  </div>
}
