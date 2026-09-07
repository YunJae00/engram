import { AppWindow, ArrowLeft, ChevronsRight, RefreshCw, TextSearch, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DesktopBindingDto, DesktopWindowDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { openDesktopStream } from '../lib/desktopStream.js'
import { DesktopControls } from './DesktopControls.js'
import { MissionPreview } from './MissionPreview.js'

export function OrbitSurface({ lane, name, open, initialBinding, onFold }: { lane: string; name: string; open(): void; initialBinding?: DesktopBindingDto; onFold?(): void }) {
  const [available, setAvailable] = useState(Boolean(initialBinding))
  const [binding, setBinding] = useState<DesktopBindingDto | undefined>(initialBinding)
  const [picking, setPicking] = useState(false)
  const [windows, setWindows] = useState<DesktopWindowDto[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [controls, setControls] = useState(false)
  useEffect(() => {
    let alive = true
    let revision = 0
    void api.desktopAvailable().then((value) => { if (alive) setAvailable(value) }).catch(() => undefined)
    const update = () => {
      const request = ++revision
      void api.desktopBindings().then((items) => { if (alive && request === revision) setBinding(items.find((item) => item.lane === lane)) }).catch(() => undefined)
    }
    update()
    const off = api.onEvent((event) => { if (event.type === 'desktop:changed') update() })
    return () => { alive = false; off() }
  }, [lane])
  const pick = async () => {
    setPicking(true); setBusy(true); setError('')
    try { setWindows(await api.desktopWindows()) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const choose = async (source: string) => {
    setBusy(true); setError('')
    try { setBinding(await api.desktopChoose(lane, source)); setPicking(false); setControls(false) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const readAccess = async () => {
    if (!binding) return
    setBusy(true); setError('')
    try { setBinding(await api.desktopReadAccess(lane, !binding.readable)); setControls(false) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  if (!available) return <MissionPreview lane={lane} name={name} open={open} />
  return <div className="orbit-surface" data-testid="orbit-surface">
    <div className="desktop-surface-toolbar">
      <button disabled={busy} onClick={() => void pick()} title="Choose an app window"><AppWindow size={13} aria-hidden /><span>{binding ? binding.name : 'App window'}</span></button>
      {binding && <>
        <button disabled={busy} className="desktop-access-toggle" aria-pressed={binding.readable} onClick={() => void readAccess()} title="Allow this chat to read accessible text from this window">{binding.readable ? 'AI can read' : 'View only'}</button>
        {binding.readable && <button aria-label="Read window text" onClick={() => setControls(!controls)}><TextSearch size={13} /></button>}
        <button aria-label="Return to browser" title="Disconnect app and return to browser" onClick={() => void api.desktopRelease(lane).catch((cause: unknown) => setError(String(cause)))}><ArrowLeft size={13} /></button>
        {onFold && <button data-testid="desktop-pane-fold" aria-label="Hide app window" title="Hide app window" onClick={onFold}><ChevronsRight size={13} /></button>}
      </>}
    </div>
    <div className="desktop-surface-content">
      {binding ? <DesktopVideo key={binding.source} lane={lane} name={binding.name} /> : <MissionPreview lane={lane} name={name} open={open} />}
      {error && <p className="desktop-surface-error" role="alert">{error}</p>}
      {picking && <div className="desktop-source-picker" role="dialog" aria-label="Choose an app window">
        <header><span>Choose an app window</span><button aria-label="Close window picker" onClick={() => setPicking(false)}><X size={14} /></button></header>
        <p>Choose an open window to view here. AI reading is off until you enable it. This view does not click or type. Keep the original window open and not minimized.</p>
        <button className="desktop-text-button" disabled={busy} onClick={() => void pick()}><RefreshCw size={12} /> {busy ? 'Finding windows…' : 'Refresh windows'}</button>
        <div className="desktop-window-list">{windows.map((window) => <button key={window.id} disabled={busy} onClick={() => void choose(window.id)}><AppWindow size={14} /><span>{window.name}</span></button>)}</div>
        {!busy && windows.length === 0 && <p>No app windows are available.</p>}
      </div>}
      {controls && binding?.readable && <DesktopControls lane={lane} close={() => setControls(false)} />}
    </div>
  </div>
}

function DesktopVideo({ lane, name }: { lane: string; name: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let stream: MediaStream | undefined
    let controller: AbortController | undefined
    let heartbeat: number | undefined
    let nativeVisible = false
    let visibilityVersion = 0
    let frames = -1
    let lastFrame = performance.now()
    const stop = () => {
      controller?.abort(); controller = undefined
      window.clearInterval(heartbeat)
      stream?.getTracks().forEach((track) => track.stop()); stream = undefined
      if (video.current) video.current.srcObject = null
      if (alive) setReady(false)
    }
    const updateVisibility = () => {
      const shown = nativeVisible && document.visibilityState !== 'hidden'
      setVisible(shown)
      if (!shown) { stop(); return }
      if (controller) return
      const capture = new AbortController()
      controller = capture
      setReady(false); setError(''); setPaused(false)
      frames = -1; lastFrame = performance.now()
      heartbeat = window.setInterval(() => {
        const current = video.current
        if (!current?.srcObject || current.readyState < 2) return
        const next = current.getVideoPlaybackQuality().totalVideoFrames
        if (next !== frames) { frames = next; lastFrame = performance.now(); setPaused(false) }
        else if (performance.now() - lastFrame > 4000) setPaused(true)
      }, 1500)
      void openDesktopStream(lane, capture.signal).then((next) => {
        if (!alive || capture.signal.aborted) { next.getTracks().forEach((track) => track.stop()); return }
        stream = next
        const current = () => alive && controller === capture
        for (const track of stream.getVideoTracks()) {
          track.addEventListener('ended', () => { if (current()) { setReady(false); setError('Window sharing ended. Choose the window again or retry.') } })
          track.addEventListener('mute', () => { if (current()) setPaused(true) })
          track.addEventListener('unmute', () => { if (current()) { lastFrame = performance.now(); setPaused(false) } })
        }
        if (video.current) { video.current.srcObject = next; void video.current.play().catch(() => undefined) }
      }).catch((cause: unknown) => { if (alive && !capture.signal.aborted) setError(String(cause)) })
    }
    document.addEventListener('visibilitychange', updateVisibility)
    const off = api.onEvent((event) => {
      if (event.type !== 'desktop:visibility') return
      visibilityVersion++
      nativeVisible = event.visible
      updateVisibility()
    })
    const request = visibilityVersion
    void api.desktopVisible().then((shown) => {
      if (!alive || request !== visibilityVersion) return
      nativeVisible = shown
      updateVisibility()
    }).catch(() => { if (alive) setError('Could not check window visibility. Retry the live view.') })
    updateVisibility()
    return () => { alive = false; off(); document.removeEventListener('visibilitychange', updateVisibility); stop() }
  }, [lane, attempt])
  return <div className="desktop-video">
    <video ref={video} autoPlay muted playsInline aria-label={`Live view of ${name}`} onPlaying={() => { if (document.visibilityState !== 'hidden' && video.current?.srcObject) setReady(true) }} />
    {!ready && <div className="desktop-video-status"><p>{error || (!visible ? 'Live view pauses while Engram is hidden.' : 'Starting live view…')}</p>{error && <button onClick={() => setAttempt((value) => value + 1)}>Retry live view</button>}</div>}
    <span className="desktop-video-caption" role="status">{ready && paused ? 'No recent frames · check that the window is not minimized' : 'Window view · read-only'}</span>
  </div>
}
