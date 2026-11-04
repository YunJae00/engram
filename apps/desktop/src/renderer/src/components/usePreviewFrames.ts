import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkPreviewDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { useShellState } from '../state-slices.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { useWebPane } from '../lib/webPane.js'
import { useNativeBrowser } from '../lib/nativeSurfaces.js'
import { useCompactBrowser } from '../lib/useCompactBrowser.js'
import { useDesktopSession } from '../lib/desktopSession.js'
import { appPreviewFor } from '../lib/appPreviewStream.js'
import type { FrameSource } from './FrameScreen.js'

export type PreviewFrame = {
  id: string; source: 'app' | 'web'; title: string; at: number; image?: string; stream?: FrameSource
  live?: boolean; reconnecting?: boolean
  activity?: string
  phase: 'activity' | 'ready' | 'waiting' | 'delayed' | 'no-snapshot' | 'unavailable' | 'empty'
  onPaint?(): void
  reason?: 'screen_recording_denied' | 'capture_unsafe'; current?: boolean
}
export type PreviewTile = { url?: string; frames: FrameSource; onOpen(): void }
export function appPreviewFrame(frame: WorkPreviewDto): PreviewFrame {
  return { id: frame.id, source: 'app', title: frame.title, at: frame.at, image: frame.data,
    activity: frame.activity, phase: frame.unavailable ? 'unavailable' : frame.captureState ?? 'ready', reason: frame.captureReason === 'capture_unavailable' ? undefined : frame.captureReason, current: frame.current }
}
export function usePreviewFrames(lane: string, tile?: PreviewTile): PreviewFrame[] {
  const { bindings } = useDesktopSession()
  const binding = bindings.find(item => item.lane === lane && item.readable)
  const { activity } = useShellState()
  const active = tile ? activity === 'mission' : activity === 'bots'
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => { setVisible(document.visibilityState === 'visible') }, [active])
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const [apps, setApps] = useState<WorkPreviewDto[]>([])
  const pane = useWebPane(lane)
  const mirror = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const native = useNativeBrowser()
  const { compact } = useCompactBrowser()
  const url = tile ? tile.url : mirror.lane === lane ? mirror.url : undefined
  const live = mirror.lane === lane && mirror.on
  const [unavailable, setUnavailable] = useState(false)
  const cached = useRef<{ data: string; url?: string; lane: string } | null>(null)
  const painted = useRef({ key: '', at: 0 })
  const [paintedKey, setPaintedKey] = useState('')
  const paintKey = `${lane}:${url ?? ''}`
  const onPaint = useCallback(() => { painted.current = { key: paintKey, at: Date.now() }; setPaintedKey(paintKey) }, [paintKey])
  useEffect(() => {
    let alive = true, received = false
    setApps([])
    const off = api.onEvent(event => {
      if (event.type === 'desktop:preview') { received = true; setApps(event.frames.filter(frame => frame.lane === lane)) }
    })
    void api.desktopPreviews(lane).then(frames => { if (alive && !received) setApps(frames.filter(frame => frame.lane === lane)) }).catch(() => {})
    return () => { alive = false; off() }
  }, [lane])
  useEffect(() => { setUnavailable(false) }, [lane, url])
  const source = useCallback<FrameSource>(paint => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    if (cached.current && cached.current.url === url && cached.current.lane === lane) paint(cached.current.data)
    const refresh = async () => {
      const data = await api.nativeSnapshot(lane).catch(() => null)
      if (!alive) return
      if (data) {
        const base64 = data.slice(data.indexOf(',') + 1)
        cached.current = { data: base64, url, lane }; paint(base64); setUnavailable(false)
      } else setUnavailable(true)
      if (live || tile) timer = setTimeout(() => void refresh(), 1000)
    }
    if (visible && active && url && url !== 'about:blank') void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [lane, live, url, tile?.frames, visible, active])
  const frames = apps.filter(frame => frame.lane === lane).map(appPreviewFrame)
  if (binding) {
    const id = `${lane}:${binding.source}`
    let frame = frames.find(item => item.id === id)
    if (!frame) { frame = { id, source: 'app', title: binding.name, at: Date.now(), phase: 'waiting' }; frames.push(frame) }
    const stream = appPreviewFor(lane)
    if (stream?.reason === 'screen_recording_denied') { frame.reason = stream.reason; if (!frame.image) frame.phase = 'unavailable' }
    if (stream) { frame.stream = stream.source; frame.live = stream.live; frame.reconnecting = stream.reconnecting }
    if (stream?.live) { frame.stream = stream.source; frame.phase = 'ready'; frame.image = undefined }
    else if (stream?.image) { frame.image = stream.image; frame.at = stream.at; frame.phase = 'ready' }
  }
  const showing = tile ? tile.url !== undefined : (pane.floating || (compact && !pane.expanded)) && !pane.folded
    && (pane.wanted || (mirror.lane === lane && (mirror.on || mirror.frame)))
  if (showing) {
    let title = ''
    try { if (url && url !== 'about:blank') title = new URL(url).hostname } catch { /* Use the localized browser title. */ }
    frames.push({ id: `${lane}:web:${url ?? ''}`, source: 'web', title, at: painted.current.key === paintKey ? painted.current.at : 0, onPaint,
      phase: !url || url === 'about:blank' ? 'empty' : unavailable ? 'unavailable' : paintedKey === paintKey ? 'ready' : 'waiting',
      stream: native || !url || url === 'about:blank' ? source : tile?.frames })
  }
  return frames
}
