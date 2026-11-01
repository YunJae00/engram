import { app, nativeImage } from 'electron'
import { desktopBinding, desktopOwner, keptOut, type DesktopBinding } from './desktop-access.js'
import type { DesktopObservationDto, WorkPreviewDto } from '../shared/desktop.js'
import { desktopImage } from './desktop-image.js'
import { tapBroadcast } from './engine-health.js'

const entries = new Map<string, WorkPreviewDto>()
const valid = new Map<string, () => boolean>()
const pending = new Map<string, AbortController>()
const deferred = new Map<string, ReturnType<typeof setTimeout>>()
const active = new Set<string>()
const lastCapture = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | undefined
let quitting = false
let hooked = false

function remove(id: string): void {
  entries.delete(id); valid.delete(id); lastCapture.delete(id)
  clearTimeout(deferred.get(id)); deferred.delete(id)
  pending.get(id)?.abort(); pending.delete(id)
}
function publish(pruneOnly = false): void {
  const count = entries.size
  for (const [id, entry] of entries) if (!valid.get(id)?.() || Date.now() - entry.at > 180_000) remove(id)
  if (pruneOnly && count === entries.size) return
  const owner = desktopOwner()
  if (owner) owner.webContents.send('engram:event', { type: 'desktop:preview', frames: [...entries.values()].reverse() })
  if (!entries.size) { clearInterval(timer); timer = undefined }
}
export function workPreviews(lane: string): WorkPreviewDto[] {
  publish()
  return [...entries.values()].filter(frame => frame.lane === lane).reverse()
}
export function closeWorkPreview(): void {
  quitting = true; active.clear()
  for (const id of entries.keys()) remove(id)
  clearInterval(timer); timer = undefined
}
export function showWorkPreview(binding: DesktopBinding): void {
  if (quitting || desktopBinding(binding.lane) !== binding || binding.host.closed || binding.stopped || !binding.readable) return
  if (!hooked) {
    hooked = true
    app.once('before-quit', closeWorkPreview)
    tapBroadcast(event => {
      if ((event.type === 'chat:done' || event.type === 'chat:error') && event.channel) {
        active.delete(event.channel)
        for (const [id, frame] of entries) if (frame.lane === event.channel) {
          pending.get(id)?.abort(); pending.delete(id)
          clearTimeout(deferred.get(id)); deferred.delete(id)
        }
      }
    })
  }
  active.add(binding.lane)
  const key = `${binding.lane}:${binding.source}`
  if (valid.has(key) && !valid.get(key)!()) remove(key)
  valid.set(key, () => {
    const current = desktopBinding(binding.lane)
    return !!current?.readable && !current.stopped && !binding.stopped && !binding.host.closed && !keptOut(binding.name)
      && (current === binding || !!entries.get(key)?.data)
  })
  const previous = entries.get(key)
  const entry: WorkPreviewDto = previous ?? { id: key, lane: binding.lane, title: binding.name, at: Date.now() }
  entries.delete(key); entries.set(key, entry)
  const laneEntries = [...entries.values()].filter(frame => frame.lane === binding.lane)
  for (const oldest of laneEntries.slice(0, -4)) remove(oldest.id)
  while (entries.size > 64) remove(entries.keys().next().value!)
  publish()
  if (!timer) timer = setInterval(() => publish(true), 1000).unref()
  if (pending.has(key)) return
  if (Date.now() - (lastCapture.get(key) ?? 0) < 2000 || pending.size >= 2) {
    if (!deferred.has(key)) deferred.set(key, setTimeout(() => {
      deferred.delete(key)
      if (active.has(binding.lane) && valid.get(key)?.()) showWorkPreview(binding)
    }, 2100).unref())
    return
  }
  const controller = new AbortController()
  pending.set(key, controller); lastCapture.set(key, Date.now())
  const timeout = setTimeout(() => controller.abort(), 5000)
  const observe = () => binding.host.request<DesktopObservationDto>('observe', { window: binding.window, pid: binding.pid }, controller.signal)
  void desktopImage(binding, observe, controller.signal).then(result => {
    if (entries.get(key) !== entry || desktopBinding(binding.lane) !== binding || !valid.get(key)?.() || controller.signal.aborted || quitting) return
    if (result.image) {
      entry.data = nativeImage.createFromBuffer(Buffer.from(result.image.data, 'base64')).resize({ width: 700 }).toDataURL()
      entry.at = Date.now(); entry.unavailable = false
    } else { delete entry.data; entry.unavailable = true }
  }).catch(() => {
    if (entries.get(key) === entry) { delete entry.data; entry.unavailable = true }
  }).finally(() => {
    clearTimeout(timeout)
    if (pending.get(key) === controller) pending.delete(key)
    if (!quitting) publish()
  })
}
