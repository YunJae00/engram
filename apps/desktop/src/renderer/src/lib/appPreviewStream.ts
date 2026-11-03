import type { DesktopBindingDto } from '../../../shared/desktop.js'
import type { FrameSource } from '../components/FrameScreen.js'
import { api } from '../api.js'
import { openDesktopStream } from './desktopStream.js'

export function appPreviewStream(lane: string, changed: () => void) {
  const controller = new AbortController()
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const listeners = new Set<(data: string) => void>()
  let stream: MediaStream | undefined
  let frame = 0
  let last = ''
  let at = 0
  let live = false
  let playback = 0
  const setLive = (next: boolean) => {
    if (live === next || next && controller.signal.aborted) return
    live = next
    void api.desktopPreviewStream(lane, next).catch(() => {})
  }
  video.muted = true; video.playsInline = true
  const stopPainting = () => { cancelAnimationFrame(frame); frame = 0 }
  const paint = () => {
    frame = 0
    if (!listeners.size || document.visibilityState === 'hidden' || !live) return
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      canvas.width = Math.min(700, video.videoWidth)
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth)
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      at = Date.now()
      last = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]!
      for (const listener of listeners) listener(last)
    }
    frame = requestAnimationFrame(paint)
  }
  const update = () => {
    const revision = ++playback
    stopPainting()
    if (live && listeners.size && document.visibilityState !== 'hidden') {
      void video.play().then(() => { if (revision === playback && !frame && live && listeners.size) frame = requestAnimationFrame(paint) }).catch(() => { if (revision === playback) failed() })
    } else video.pause()
  }
  const failed = () => { setLive(false); stopPainting(); video.pause(); changed() }
  document.addEventListener('visibilitychange', update)
  void openDesktopStream(lane, controller.signal).then(next => {
    if (controller.signal.aborted) { next.getTracks().forEach(track => track.stop()); return }
    stream = next; video.srcObject = next; setLive(true)
    for (const track of next.getVideoTracks()) {
      track.addEventListener('ended', failed)
      track.addEventListener('mute', failed)
      track.addEventListener('unmute', () => { setLive(true); changed(); update() })
    }
    changed(); update()
  }).catch(() => { if (!controller.signal.aborted) failed() })
  const source: FrameSource = listener => {
    listeners.add(listener)
    if (last) listener(last)
    update()
    return () => { listeners.delete(listener); update() }
  }
  return {
    source,
    get live() { return live },
    get at() { return at },
    get image() { return last ? `data:image/jpeg;base64,${last}` : undefined },
    close() {
      controller.abort(); playback++; setLive(false); stopPainting(); listeners.clear()
      document.removeEventListener('visibilitychange', update)
      video.pause(); video.srcObject = null
      stream?.getTracks().forEach(track => track.stop())
    },
  }
}


const streams = new Map<string, { source: string; stopped: boolean; stream: ReturnType<typeof appPreviewStream> }>()
const visible = new Set<string>()
const working = new Set<string>()
let currentBindings: DesktopBindingDto[] = []
let notify = () => {}
export function setAppPreviewVisible(lane: string, showing: boolean, busy = true): void {
  if (visible.has(lane) === showing && working.has(lane) === (showing && busy)) return
  if (showing) visible.add(lane); else visible.delete(lane)
  if (showing && busy) working.add(lane); else working.delete(lane)
  syncAppPreviewStreams(currentBindings, notify)
  notify()
}
export function syncAppPreviewStreams(bindings: DesktopBindingDto[], changed: () => void): void {
  currentBindings = bindings
  notify = changed
  bindings = bindings.filter(item => visible.has(item.lane)).map(item => ({ ...item, stopped: item.stopped || !working.has(item.lane) }))
  for (const [lane, held] of streams) {
    const binding = bindings.find(item => item.lane === lane && item.readable && item.source === held.source)
    if (!binding || held.stopped && !binding.stopped) { held.stream.close(); streams.delete(lane) }
    else if (binding.stopped && !held.stopped) { held.stream.close(); held.stopped = true }
  }
  for (const binding of bindings) if (binding.readable && !binding.stopped && !streams.has(binding.lane)) {
    streams.set(binding.lane, { source: binding.source, stopped: false, stream: appPreviewStream(binding.lane, changed) })
  }
}
export function appPreviewFor(lane: string) { return streams.get(lane)?.stream }
