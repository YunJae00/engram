import { Monitor } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FrameScreen } from './FrameScreen.js'
import { onMissionFrame } from '../lib/missionFramesLive.js'
import { t } from '../i18n.js'
import { NativeSurface } from './NativeSurface.js'
import { useNativeBrowser } from '../lib/nativeSurfaces.js'
import { api } from '../api.js'
import { useBrowserViewport } from '../lib/useBrowserViewport.js'
import { BrowserAddress, BrowserStart } from './WebPane.js'
import { BrowserActions } from './BrowserActions.js'

export function MissionPreview({ lane, name, open, onLiveChange }: { lane: string; name: string; open(): void; onLiveChange?(live: boolean): void }) {
  const native = useNativeBrowser()
  const [live, setLive] = useState(false)
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!native) return
    let alive = true
    const update = () => { void api.missionFrames([lane]).then(([frame]) => { if (alive) { setLive(Boolean(frame?.on && frame.url && frame.url !== 'about:blank')); setUrl(frame?.url ?? '') } }).catch(() => undefined) }
    update()
    const timer = setInterval(update, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [lane, native])
  const [painted, setPainted] = useState(false)
  useEffect(() => onLiveChange?.(native ? live : painted), [native, live, painted, onLiveChange])
  const viewport = useRef<HTMLButtonElement>(null)
  useBrowserViewport(viewport, lane, !native && painted)
  const source = useCallback((paint: (data: string) => void) => {
    let started = false
    return onMissionFrame(lane, (frame) => {
      if (!frame.on || !frame.url || frame.url === 'about:blank') { started = false; setPainted(false); return }
      if (!frame.data) return
      paint(frame.data)
      if (!started) { started = true; setPainted(true) }
    })
  }, [lane])
  if (native) return (
    <div className="mission-preview native-mission-preview">
      <div className="web-pane-bar"><BrowserAddress key={`address-${lane}`} channel={lane} url={url} /><BrowserActions key={`actions-${lane}`} lane={lane} url={url} live={live} /></div>
      {live ? <NativeSurface lane={lane} /> : <BrowserStart channel={lane} />}
    </div>
  )
  return (
    <button ref={viewport} className="mission-preview" data-live={painted} aria-label={t('mission.open', { name })} onClick={open}>
      <FrameScreen source={source} />
      {!painted && <div className="mission-text"><Monitor size={26} strokeWidth={1.4} /><p>{t('mission.chat')}</p></div>}
    </button>
  )
}
