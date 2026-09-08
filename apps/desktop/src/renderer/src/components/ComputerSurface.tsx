import { AppWindow, ChevronDown, Eye, LoaderCircle, Monitor, Pause, RefreshCw, ShieldCheck, Square, TextSearch, Unplug, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DesktopWindowDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { desktopError, hasDesktopGrant, refreshDesktop, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { DesktopControls } from './DesktopControls.js'
import { DesktopVideo } from './DesktopVideo.js'

export function ComputerSurface({ lane }: { lane: string }) {
  const { available, bindings, control, error: statusError } = useDesktopSession()
  const binding = bindings.find((item) => item.lane === lane)
  const owner = control && control.state !== 'idle' ? control : null
  const reserved = hasDesktopGrant(control)
  const mine = owner?.lane === lane
  const [picking, setPicking] = useState(false)
  const [windows, setWindows] = useState<DesktopWindowDto[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingWindows, setLoadingWindows] = useState(false)
  const [error, setError] = useState('')
  const [textOpen, setTextOpen] = useState(false)
  const alive = useRef(true)
  const picker = useRef<HTMLDivElement>(null)
  const pickerTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refreshDesktop() }
    catch (cause) { if (alive.current) setError(desktopError(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const findWindows = async () => {
    setLoadingWindows(true); setError('')
    try { const next = await api.desktopWindows(); if (alive.current) setWindows(next) }
    catch (cause) { if (alive.current) setError(desktopError(cause)) }
    finally { if (alive.current) setLoadingWindows(false) }
  }
  const pick = () => { setPicking(true); setQuery(''); void findWindows() }
  const closePicker = () => { setPicking(false); pickerTrigger.current?.focus() }
  useEffect(() => {
    if (!picking) return
    picker.current?.querySelector<HTMLInputElement>('input')?.focus()
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setPicking(false); pickerTrigger.current?.focus() }
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target) && !pickerTrigger.current?.contains(event.target)) setPicking(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside) }
  }, [picking])
  if (available !== true) return <div className="computer-empty" data-testid="computer-unavailable">
    <Monitor size={30} strokeWidth={1.4} aria-hidden /><strong>{available === null ? 'Checking computer access…' : 'Computer access is unavailable'}</strong>
    <p>{statusError || 'This build supports app access on Windows. Browser work remains available in the Browser tab.'}</p>
    {statusError && <button className="computer-secondary" onClick={() => void refreshDesktop()}>Try again</button>}
  </div>
  const ownedElsewhere = reserved && !mine
  const visibleWindows = windows.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const state = mine ? owner.state : binding?.readable ? 'read' : 'view'
  return <div className="computer-surface" data-state={state} data-testid="computer-surface">
    <header className="computer-window-bar">
      <button ref={pickerTrigger} className="computer-window-choice" disabled={busy || reserved} onClick={pick} aria-expanded={picking} aria-label={binding ? `Change window: ${binding.name}` : 'Choose an app window'}>
        <AppWindow size={14} aria-hidden /><span>{binding?.name || 'Choose an app window'}</span><ChevronDown size={13} aria-hidden />
      </button>
      {binding && <button className="computer-icon" disabled={busy || reserved} aria-label="Disconnect app window" title="Disconnect app window" onClick={() => void run(async () => { await api.desktopRelease(lane); if (alive.current) setTextOpen(false) })}><Unplug size={14} aria-hidden /></button>}
    </header>
    <div className="computer-content">
      {binding ? <DesktopVideo key={binding.source} lane={lane} name={binding.name} /> : <div className="computer-empty">
        <Monitor size={30} strokeWidth={1.4} aria-hidden /><strong>Your apps, in this conversation</strong>
        <p>Choose an open window to preview. Reading and computer control stay off until you allow them.</p>
        <button className="computer-primary" disabled={reserved} onClick={pick}><AppWindow size={14} aria-hidden />Choose a window</button>
        <span>One computer · one controlling chat at a time</span>
      </div>}
      {picking && <div className="desktop-source-picker" ref={picker} aria-label="App window picker">
        <header><strong>Choose a window</strong><button className="computer-icon" aria-label="Close window picker" onClick={closePicker}><X size={15} aria-hidden /></button></header>
        <p>Only this window is shared. Keep it open and not minimized.</p>
        <div className="computer-picker-search"><input aria-label="Find an app window" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an app or window" /><button className="computer-icon" disabled={loadingWindows} title="Refresh windows" aria-label="Refresh windows" onClick={() => void findWindows()}><RefreshCw size={14} aria-hidden /></button></div>
        <div className="desktop-window-list" aria-busy={loadingWindows}>
          {loadingWindows && <p role="status">Finding open windows…</p>}
          {!loadingWindows && visibleWindows.map((item) => {
            const other = bindings.some((one) => one.source === item.id && one.lane !== lane)
            return <button key={item.id} disabled={busy || other} onClick={() => void run(async () => { await api.desktopChoose(lane, item.id); if (alive.current) { setPicking(false); setTextOpen(false) } })}><AppWindow size={16} aria-hidden /><span>{item.name}</span>{other && <small>Another chat</small>}</button>
          })}
          {!loadingWindows && !visibleWindows.length && <p>{query ? 'No matching windows.' : 'No windows are available. Open the app you want to use, then refresh.'}</p>}
        </div>
      </div>}
      {textOpen && binding?.readable && <DesktopControls key={binding.source} lane={lane} close={() => setTextOpen(false)} />}
    </div>
    {(error || statusError) && <p className="computer-error" role="alert">{error || statusError}</p>}
    {ownedElsewhere && <p className="computer-owner-note" role="status"><Pause size={13} aria-hidden />Another chat has computer control. Stop that session before starting here.</p>}
    {binding && <footer className="computer-access">
      <div className="computer-access-heading">
        {mine ? owner.state === 'running' ? <LoaderCircle className="computer-spinner" size={14} aria-hidden /> : owner.state === 'ready' ? <ShieldCheck size={14} aria-hidden /> : <Pause size={14} aria-hidden /> : binding.readable ? <ShieldCheck size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        <strong>{mine ? owner.state === 'ready' ? 'Ready for your next task' : owner.state === 'running' ? 'This chat can control your computer' : owner.state === 'needs-person' ? 'Your attention is needed' : 'Control paused' : binding.readable ? 'AI can read this window' : 'Preview only'}</strong>
        {binding.readable && <button className="computer-icon" aria-label="Read window text" aria-pressed={textOpen} title="Read window text" onClick={() => setTextOpen(!textOpen)}><TextSearch size={14} aria-hidden /></button>}
      </div>
      <p>{mine ? owner.reason || (owner.state === 'ready' ? 'Send this chat a task. Your mouse and keyboard stay yours until it starts.' : owner.state === 'paused' ? 'Your mouse and keyboard are yours. Allow access again when you are ready.' : owner.state === 'needs-person' ? 'Check the permission request, or stop to cancel it.' : 'Your real mouse and keyboard are shared. Press Esc to stop.') : 'Control uses your real mouse and keyboard. You can stop it at any time.'}</p>
      <div className="computer-access-actions">
        {mine ? <>
          {owner.state === 'paused' && <button className="computer-primary" disabled={busy || Boolean(statusError)} onClick={() => void run(() => api.desktopControlStart(lane))}>Allow control again</button>}
          <button className="computer-stop" onClick={() => void run(stopComputerControl)}>{owner.state === 'paused' ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{owner.state === 'paused' ? 'Dismiss' : 'Stop'}{owner.state !== 'paused' && <kbd>Esc</kbd>}</button>
        </> : <>
          <button className="computer-secondary" disabled={busy || ownedElsewhere} onClick={() => void run(async () => { await api.desktopReadAccess(lane, !binding.readable); if (alive.current) setTextOpen(false) })}>{binding.readable ? 'Turn off reading' : 'Allow reading'}</button>
          <button className="computer-primary" data-testid="computer-control-start" disabled={busy || ownedElsewhere || !control || Boolean(statusError)} onClick={() => void run(() => api.desktopControlStart(lane))}>{busy ? 'Please wait…' : 'Allow control for this session'}</button>
        </>}
      </div>
    </footer>}
  </div>
}
