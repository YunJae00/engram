import { ArrowRight, Monitor } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FrameScreen } from './FrameScreen.js'
import { onMissionFrame } from '../lib/missionFramesLive.js'
import { t } from '../i18n.js'
import { NativeSurface } from './NativeSurface.js'
import { useNativeBrowser } from '../lib/nativeSurfaces.js'
import { api } from '../api.js'
import { useBrowserViewport } from '../lib/useBrowserViewport.js'

export function MissionPreview({ lane, name, open }: { lane: string; name: string; open(): void }) {
  const native = useNativeBrowser()
  const [live, setLive] = useState(false)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!native) return
    let alive = true
    const update = () => { void api.missionFrames([lane]).then(([frame]) => { if (alive) setLive(Boolean(frame?.on)) }).catch(() => undefined) }
    update()
    const timer = setInterval(update, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [lane, native])
  const [painted, setPainted] = useState(false)
  const viewport = useRef<HTMLButtonElement>(null)
  useBrowserViewport(viewport, lane, !native && painted)
  const source = useCallback((paint: (data: string) => void) => {
    let started = false
    return onMissionFrame(lane, (frame) => {
      if (!frame.data) return
      paint(frame.data)
      if (!started) { started = true; setPainted(true) }
    })
  }, [lane])
  if (native) return (
    <div className="mission-preview native-mission-preview">
      {live ? <NativeSurface lane={lane} /> : <form className="native-browser-empty" onSubmit={(event) => {
        event.preventDefault()
        const typed = address.trim()
        if (!typed) return
        setError('')
        void api.agentGo(/^[a-z]+:/i.test(typed) ? typed : `https://${typed}`, lane).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not open the website'))
      }}>
        <p className="native-browser-empty-title">Open a website</p>
        <div className="native-browser-address"><input aria-label="Website address" placeholder="Enter a website" value={address} onChange={(event) => setAddress(event.target.value)} /><button type="submit" aria-label="Open" title="Open"><ArrowRight size={15} aria-hidden /></button></div>
        {error && <p role="alert">{error}</p>}
      </form>}
    </div>
  )
  return (
    <button ref={viewport} className="mission-preview" aria-label={t('mission.open', { name })} onClick={open}>
      <FrameScreen source={source} />
      {!painted && <div className="mission-text"><Monitor size={26} strokeWidth={1.4} /><p>{t('mission.chat')}</p></div>}
    </button>
  )
}
