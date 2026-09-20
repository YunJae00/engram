import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Folder, Gauge, GitBranch, ShieldCheck, ShieldOff, X } from 'lucide-react'
import type { DevMode, DevSession, DevUsage } from '../../../shared/developers.js'
import { AccountUsage } from './AccountUsage.js'

export function DeveloperPopover({ label, trigger, disabled, children }: { label: string; trigger: ReactNode; disabled?: boolean; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false), anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId()
  const close = () => { setOpen(false); anchor.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(), menu = panel.current
      if (!rect || !menu) return
      const width = Math.min(320, innerWidth - 24), above = rect.top - 16, below = innerHeight - rect.bottom - 16
      Object.assign(menu.style, { width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`, top: below > above ? `${rect.bottom + 6}px` : 'auto', bottom: below > above ? 'auto' : `${innerHeight - rect.top + 6}px`, maxHeight: `${Math.max(80, Math.max(above, below))}px` })
    }
    place(); panel.current?.querySelector<HTMLElement>('button, input')?.focus()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    window.addEventListener('pointerdown', away); window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key, true) }
  }, [open])
  return <><button className="dev-control" ref={anchor} disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{trigger}</button>{open && createPortal(<div className="dev-popover" ref={panel} id={id} role="dialog" aria-label={label}><header><strong>{label}</strong><button className="dev-control" aria-label={`Close ${label}`} onClick={close}><X size={14} /></button></header>{children(close)}</div>, document.body)}</>
}

export const ACCESS: { id: DevMode; name: string; detail: string }[] = [
  { id: 'review', name: 'Ask before changes', detail: 'Review edits and command requests before approving.' },
  { id: 'plan', name: 'Plan only', detail: 'Inspect and discuss. Do not approve file changes.' },
  { id: 'auto-edit', name: 'Automatic edits', detail: 'Edit in a separate worktree. Other actions may still ask.' },
  { id: 'full-access', name: 'Full access', detail: 'Commands and file changes can run without approval.' },
]
export interface AccessSelection { mode: DevMode; isolate: boolean; confirmed: boolean }
function AccessForm({ value, task, extensions, onChange, close }: { value: AccessSelection; task: DevSession | null; extensions: boolean; onChange(value: AccessSelection): Promise<void>; close(): void }) {
  const [next, setNext] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState(''), group = useId()
  return <><div className="dev-access-options">{ACCESS.map(option => <label key={option.id} className={next.mode === option.id ? 'selected' : ''}>
    <input type="radio" name={group} checked={next.mode === option.id} disabled={busy || (option.id === 'auto-edit' && !!task && !task.branch)} onChange={() => setNext(current => ({ ...current, mode: option.id, confirmed: false, isolate: option.id === 'auto-edit' || current.isolate }))} /><span><strong>{option.name}</strong><small>{option.detail}</small></span>{next.mode === option.id && <Check size={14} />}
  </label>)}</div>
    {!task ? <fieldset className="dev-location"><legend>Working folder</legend><label><input type="radio" name={`${group}-folder`} checked={!next.isolate} disabled={busy || next.mode === 'auto-edit'} onChange={() => setNext(current => ({ ...current, isolate: false }))} /><Folder size={14} />Current folder</label><label><input type="radio" name={`${group}-folder`} checked={next.isolate} disabled={busy || next.mode === 'auto-edit'} onChange={() => setNext(current => ({ ...current, isolate: true }))} /><GitBranch size={14} />Separate worktree</label><p>A worktree separates file changes. It is not a security sandbox.</p></fieldset> : <p className="setting-hint">{task.branch ? 'This session uses a separate worktree.' : 'This session uses your current folder. Branch the session for automatic edits.'}</p>}
    {next.mode === 'full-access' && <label className="dev-full-confirm"><input type="checkbox" checked={next.confirmed} disabled={busy} onChange={event => setNext(current => ({ ...current, confirmed: event.target.checked }))} /><span>I allow commands and file changes without approval.{extensions && ' Installed hooks and project extensions are also enabled.'}</span></label>}
    {error && <p role="alert">{error}</p>}<button className="primary dev-popover-apply" disabled={busy || (next.mode === 'full-access' && !next.confirmed)} onClick={() => { setBusy(true); void onChange(next).then(close).catch(error => setError(error.message)).finally(() => setBusy(false)) }}>{busy ? 'Applying…' : 'Apply'}</button>
  </>
}
export function DeveloperAccess({ value, task, disabled, extensions, onChange }: { value: AccessSelection; task: DevSession | null; disabled: boolean; extensions: boolean; onChange(value: AccessSelection): Promise<void> }) {
  return <DeveloperPopover label="Task access" disabled={disabled} trigger={<>{value.mode === 'full-access' ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}<span>{ACCESS.find(option => option.id === value.mode)?.name}</span></>}>{close => <AccessForm value={value} task={task} extensions={extensions} onChange={onChange} close={close} />}</DeveloperPopover>
}

export function DeveloperUsage({ usage }: { usage: DevUsage }) {
  return <DeveloperPopover label="Usage and limits" trigger={<Gauge size={15} />}>{() => <><p className="setting-hint">{usage.input === undefined ? 'Token usage appears when reported.' : `${usage.input.toLocaleString('en-US')} input · ${(usage.output ?? 0).toLocaleString('en-US')} output tokens`}</p>{usage.cost !== undefined && <p className="setting-hint">Estimated API cost: ${usage.cost.toFixed(4)}. This is not your subscription bill.</p>}<AccountUsage /></>}</DeveloperPopover>
}
