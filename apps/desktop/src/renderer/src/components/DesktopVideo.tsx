import { Monitor, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { desktopError } from '../lib/desktopSession.js'
import { openDesktopStream } from '../lib/desktopStream.js'

export function DesktopVideo({ lane, name }: { lane: string; name: string }) {
  const host = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let nativeVisible = false
    let intersecting = false
    let visibilityRevision = 0
    let stream: MediaStream | undefined
    let controller: AbortController | undefined
    const stop = () => {
      controller?.abort(); controller = undefined
      stream?.getTracks().forEach((track) => track.stop()); stream = undefined
      if (video.current) video.current.srcObject = null
      if (alive) setReady(false)
    }
    const update = () => {
      if (!alive) return
      const shown = nativeVisible && intersecting && document.visibilityState !== 'hidden'
      setVisible(shown)
      if (!shown) { stop(); return }
      if (controller) return
      const capture = new AbortController()
      controller = capture
      setReady(false); setError(''); setPaused(false)
      void openDesktopStream(lane, capture.signal).then((next) => {
        if (!alive || capture.signal.aborted) { next.getTracks().forEach((track) => track.stop()); return }
        stream = next
        const current = () => alive && controller === capture
        for (const track of next.getVideoTracks()) {
          track.addEventListener('ended', () => { if (current()) { setReady(false); setError('Window sharing ended. Reconnect the window or retry.') } })
          track.addEventListener('mute', () => { if (current()) setPaused(true) })
          track.addEventListener('unmute', () => { if (current()) setPaused(false) })
        }
        if (video.current) {
          video.current.srcObject = next
          void video.current.play().catch(() => { if (current()) setError('The live preview could not start. Try again.') })
        }
      }).catch((cause: unknown) => { if (alive && !capture.signal.aborted) setError(desktopError(cause)) })
    }
    const observer = new IntersectionObserver(([entry]) => { intersecting = Boolean(entry?.isIntersecting); update() })
    if (host.current) observer.observe(host.current)
    document.addEventListener('visibilitychange', update)
    const off = api.onEvent((event) => {
      if (event.type !== 'desktop:visibility') return
      visibilityRevision++; nativeVisible = event.visible; update()
    })
    const revision = visibilityRevision
    void api.desktopVisible().then((shown) => {
      if (!alive || revision !== visibilityRevision) return
      nativeVisible = shown; update()
    }).catch(() => { if (alive) setError('Could not check window visibility. Retry the preview.') })
    return () => { alive = false; observer.disconnect(); off(); document.removeEventListener('visibilitychange', update); stop() }
  }, [lane, attempt])
  return <div className="desktop-video" ref={host} data-testid="desktop-video">
    <div className="desktop-video-stage">
      <video ref={video} autoPlay muted playsInline aria-label={`Read-only live view of ${name}`} onPlaying={() => { if (video.current?.srcObject && document.visibilityState !== 'hidden') setReady(true) }} />
      {(!ready || error) && <div className="desktop-video-status" role="status">
        <Monitor size={24} strokeWidth={1.5} aria-hidden />
        <p>{error || (!visible ? 'The preview pauses when it is out of view.' : 'Connecting the live preview…')}</p>
        {error && <button className="computer-secondary" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={13} aria-hidden />Retry preview</button>}
      </div>}
    </div>
    <p className="desktop-preview-caption" role="status">{paused ? 'Preview paused · keep the original window open' : 'Live preview only · use the original window to interact'}</p>
  </div>
}
