import { useEffect, useId, useState } from 'react'
import { Check, ClipboardList, ShieldCheck, ShieldOff } from 'lucide-react'
import type { PermissionMode } from 'core'
import { api } from '../api.js'
import { DeveloperPopover } from './DeveloperControls.js'

export const PERMISSION_CHOICES: { id: PermissionMode; name: string; detail: string }[] = [
  { id: 'once', name: 'Ask once', detail: 'The first command asks; later ones run. Edits stay in the task folder.' },
  { id: 'each', name: 'Ask every time', detail: 'Claude asks before each command. ChatGPT uses Engram tools without native commands.' },
  { id: 'auto', name: 'Automatic', detail: 'Commands run without asking. ChatGPT runs them sandboxed; Claude does not.' },
  { id: 'plan', name: 'Plan only', detail: 'Reads and plans. No commands, file changes or office edits.' },
]

export function CometPermission({ scope }: { scope: string }) {
  const [mode, setMode] = useState<PermissionMode>('once'), [error, setError] = useState(''), group = useId()
  useEffect(() => {
    let alive = true
    void api.settingsGet().then(settings => { if (alive) setMode(settings.aiSelections?.[scope]?.permission ?? 'once') }).catch(() => undefined)
    const off = api.onEvent(event => { if (event.type === 'settings:changed') setMode(event.settings.aiSelections?.[scope]?.permission ?? 'once') })
    return () => { alive = false; off() }
  }, [scope])
  const current = PERMISSION_CHOICES.find(choice => choice.id === mode)!
  const Icon = mode === 'plan' ? ClipboardList : mode === 'auto' ? ShieldOff : ShieldCheck
  return <DeveloperPopover label="Permissions" className="chat-attach-button" hint={`Permissions: ${current.name}`} trigger={<Icon size={16} aria-hidden />}>{close => <>
    <div className="dev-access-options">{PERMISSION_CHOICES.map(choice => <label key={choice.id} className={mode === choice.id ? 'selected' : ''}>
      <input type="radio" name={group} checked={mode === choice.id} data-testid={`permission-pick-${choice.id}`} onChange={() => {
        const before = mode
        setError(''); setMode(choice.id)
        void api.aiPermissionSet(scope, choice.id).then(close).catch((failure: Error) => { setMode(before); setError(failure.message) })
      }} /><span><strong>{choice.name}</strong><small>{choice.detail}</small></span>{mode === choice.id && <Check size={14} aria-hidden />}
    </label>)}</div>
    {error && <p role="alert">{error}</p>}
  </>}</DeveloperPopover>
}
