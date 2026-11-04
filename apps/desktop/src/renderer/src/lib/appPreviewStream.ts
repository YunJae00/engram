import type { DesktopBindingDto } from '../../../shared/desktop.js'
import type { FrameSource } from '../components/FrameScreen.js'
import { api } from '../api.js'
import { openDesktopStream } from './desktopStream.js'

export function appPreviewStream(lane: string, changed: () => void, hidden = false) {
  const controller = new AbortController()
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const listeners = new Set<(data: string) => void>()
  let opening = false
  let stream: MediaStream | undefined
  let frame = 0
  let last = ''
  let at = 0
  let live = false
  let reason: string | undefined
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let exhausted = false
  let reconnecting = false
  const event = (event: 'start' | 'live' | 'retry' | 'failed' | 'ended', reason?: string) => { void api.desktopPreviewStreamEvent(lane, { event, reason, attempt: attempts }).catch(() => {}) }
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
      void video.play().then(() => { if (revision === playback && !frame && live && listeners.size) frame = requestAnimationFrame(paint) }).catch(error => { if (revision === playback) failed(error instanceof Error ? error.message : 'play-failed') })
    } else video.pause()
  }
  const eligible = () => !controller.signal.aborted && document.visibilityState !== 'hidden'
  const schedule = () => {
    if (retry || exhausted || !eligible()) return
    if (attempts >= 5) { exhausted = true; reconnecting = false; changed(); return }
    reconnecting = true
    retry = setTimeout(() => {
      retry = undefined
      if (!eligible()) return
      attempts++; event('retry', reason); start()
    }, [2000, 5000, 10000, 20000][Math.min(attempts, 3)])
  }
  const failed = (why: string, ended = false) => {
    if (controller.signal.aborted) return
    reason = hidden ? `hidden-window-source-unavailable: ${why}` : why; playback++; setLive(false); stopPainting(); video.pause()
    const held = stream; stream = undefined; video.srcObject = null
    held?.getTracks().forEach(track => track.stop())
    if (hidden) { exhausted = true; reconnecting = false }
    event(ended ? 'ended' : 'failed', reason); schedule(); changed()
  }
  const visibility = () => { update(); if (!live && reason) schedule(); else if (!stream && eligible()) start() }
  document.addEventListener('visibilitychange', visibility)
  const start = () => {
    if (!eligible() || opening || stream) return
    opening = true
    event('start')
    void openDesktopStream(lane, controller.signal).then(next => {
      opening = false
      if (controller.signal.aborted) { next.getTracks().forEach(track => track.stop()); return }
      stream = next; video.srcObject = next; reason = undefined; reconnecting = false; setLive(true)
      event('live')
      for (const track of next.getVideoTracks()) {
        track.addEventListener('ended', () => { if (stream === next) failed('track-ended', true) })
        track.addEventListener('mute', () => { if (stream === next) { playback++; setLive(false); stopPainting(); video.pause(); changed() } })
        track.addEventListener('unmute', () => { if (stream === next && !controller.signal.aborted) { setLive(true); changed(); update() } })
      }
      changed(); update()
    }).catch(error => { opening = false; if (!controller.signal.aborted) failed(error instanceof Error ? error.message : String(error)) })
  }
  start()
  const source: FrameSource = listener => {
    listeners.add(listener)
    if (last) listener(last)
    update()
    return () => { listeners.delete(listener); update() }
  }
  return {
    source,
    get exhausted() { return exhausted },
    get reconnecting() { return reconnecting },
    get reason() { return reason },
    get live() { return live },
    get connecting() { return !controller.signal.aborted && !live && !reason },
    get at() { return at },
    get image() { return last ? `data:image/jpeg;base64,${last}` : undefined },
    close() {
      if (controller.signal.aborted) return
      event('ended', 'closed')
      controller.abort(); clearTimeout(retry); reconnecting = false; playback++; setLive(false); stopPainting(); listeners.clear()
      document.removeEventListener('visibilitychange', visibility)
      video.pause(); video.srcObject = null
      stream?.getTracks().forEach(track => track.stop())
    },
  }
}


const streams = new Map<string, { source: string; stopped: boolean; stream: ReturnType<typeof appPreviewStream> }>()
const visible = new Set<string>()
const holders = new Map<string, Set<string>>()
let currentBindings: DesktopBindingDto[] = []
let notify = () => {}
export function setAppPreviewVisible(lane: string, showing: boolean, owner = lane): void {
  const held = holders.get(lane) ?? new Set<string>()
  if (showing) held.add(owner); else held.delete(owner)
  if (held.size) holders.set(lane, held); else holders.delete(lane)
  const next = held.size > 0
  if (visible.has(lane) === next) return
  if (next) visible.add(lane); else visible.delete(lane)
  void api.desktopPreviewVisible(lane, next).catch(() => {})
  syncAppPreviewStreams(currentBindings, notify)
  notify()
}
export function syncAppPreviewStreams(bindings: DesktopBindingDto[], changed: () => void): void {
  currentBindings = bindings
  notify = changed
  bindings = bindings.filter(item => visible.has(item.lane))
  for (const [lane, held] of streams) {
    const binding = bindings.find(item => item.lane === lane && item.readable && item.source === held.source)
    if (!binding || held.stopped && !binding.stopped || held.stream.exhausted && !binding.stopped && !binding.hiddenByEngram) { held.stream.close(); streams.delete(lane) }
    else if (binding.stopped && !held.stopped) { held.stream.close(); held.stopped = true }
  }
  for (const binding of bindings) if (binding.readable && !binding.stopped && !streams.has(binding.lane)) {
    streams.set(binding.lane, { source: binding.source, stopped: false, stream: appPreviewStream(binding.lane, changed, !!binding.hiddenByEngram) })
  }
}
export function appPreviewFor(lane: string) { return streams.get(lane)?.stream }
