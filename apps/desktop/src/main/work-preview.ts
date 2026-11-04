import { app, nativeImage } from 'electron'
import { desktopBinding, desktopOwner, refreshHiddenApp, restoreHiddenApp, releaseDesktop, keptOut, type DesktopBinding } from './desktop-access.js'
import type { WorkPreviewDto } from '../shared/desktop.js'
import { previewImage } from './desktop-image.js'
import { tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'

const entries = new Map<string, WorkPreviewDto>()
const owners = new Map<string, DesktopBinding>()
const valid = new Map<string, () => boolean>()
const pending = new Map<string, AbortController>()
const deferred = new Map<string, ReturnType<typeof setTimeout>>()
const active = new Set<string>()
const visible = new Set<string>()
let polling: ReturnType<typeof setInterval> | undefined
const refreshing = new Set<string>()
export function setWorkPreviewVisible(lane: string, showing: boolean): void {
  if (typeof lane !== 'string' || !/^bot-[a-zA-Z0-9_-]{1,140}$/.test(lane) || typeof showing !== 'boolean') throw new Error('Invalid preview visibility.')
  if (showing) visible.add(lane); else visible.delete(lane)
  const refresh = async (lane: string) => {
    if (refreshing.has(lane)) return
    let binding = desktopBinding(lane)
    if (!binding || binding.stopped || binding.host.closed || !binding.readable) return
    refreshing.add(lane)
    try {
      binding = await refreshHiddenApp(binding)
      if (visible.has(lane) && !streaming.has(lane)) showWorkPreview(binding, false)
    } catch (error) {
      flog('desktop-preview', String(error))
      if (desktopBinding(lane) === binding && /window is unavailable|window no longer exists/i.test(String(error))) releaseDesktop(lane)
    }
    finally { refreshing.delete(lane) }
  }
  if (showing) void refresh(lane)
  if (visible.size && !polling) polling = setInterval(() => { for (const lane of visible) void refresh(lane) }, 1500).unref()
  if (!visible.size) { clearInterval(polling); polling = undefined }
}
const streaming = new Set<string>()
const streamOwners = new Map<string, DesktopBinding>()
const preemptions = new Map<string, number>()
const lastSuccess = new Map<string, number>()
const transparentFailures = new WeakMap<DesktopBinding, number>()
const lastCapture = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | undefined
let quitting = false
let hooked = false

export function setWorkPreviewStream(lane: string, live: boolean): void {
  if (typeof lane !== 'string' || typeof live !== 'boolean') throw new Error('Choose a valid chat and stream state.')
  const binding = desktopBinding(lane)
  if (live) {
    if (quitting || !binding?.readable || binding.stopped || binding.host.closed || keptOut(binding.name)) return
    hookPreviewEvents()
    streaming.add(lane); streamOwners.set(lane, binding)
    for (const [id, frame] of entries) if (frame.lane === lane) {
      clearTimeout(deferred.get(id)); deferred.delete(id)
      pending.get(id)?.abort()
    }
  } else {
    streaming.delete(lane); streamOwners.delete(lane)
    if (binding && (active.has(lane) || visible.has(lane))) showWorkPreview(binding, active.has(lane))
  }
}
function remove(id: string): void {
  entries.delete(id); owners.delete(id); valid.delete(id); lastCapture.delete(id)
  clearTimeout(deferred.get(id)); deferred.delete(id)
  pending.get(id)?.abort(); pending.delete(id)
}
function publish(pruneOnly = false): void {
  const count = entries.size
  for (const [id, entry] of entries) {
    if (!valid.get(id)?.() || (!entry.data && Date.now() - entry.at > 180_000)) remove(id)
    else if (entry.captureState !== 'activity') entry.current = entry.captureState === 'ready' && active.has(entry.lane) && desktopBinding(entry.lane) === owners.get(id)
  }
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
  clearInterval(polling); polling = undefined; visible.clear()
  quitting = true; lastSuccess.clear(); active.clear(); preemptions.clear(); streaming.clear(); streamOwners.clear()
  for (const id of entries.keys()) remove(id)
  clearInterval(timer); timer = undefined
}
function hookPreviewEvents(): void {
  if (!hooked) {
    hooked = true
    app.once('before-quit', closeWorkPreview)
    tapBroadcast(event => {
      if (event.type === 'desktop:changed') for (const [lane, binding] of streamOwners) {
        if (desktopBinding(lane) !== binding || !binding.readable || binding.stopped || binding.host.closed) {
          streaming.delete(lane); streamOwners.delete(lane)
        }
      }
      if ((event.type === 'chat:done' || event.type === 'chat:error') && event.channel) {
        active.delete(event.channel); preemptions.delete(event.channel)
        for (const [id, frame] of entries) if (frame.lane === event.channel) {
          if (!visible.has(event.channel)) { clearTimeout(deferred.get(id)); deferred.delete(id) }
          frame.current = false
          if (frame.captureState !== 'unavailable' && frame.captureState !== 'activity') frame.captureState = frame.data ? 'delayed' : 'no-snapshot'
        }
        publish()
      }
    })
  }
}
export function officeWorkPreview(lane: string, op: string): () => void {
  if (quitting) return () => {}
  hookPreviewEvents()
  const title = op.startsWith('outlook.') ? 'Outlook' : op.startsWith('excel.') ? 'Excel' : op.startsWith('word.') ? 'Word' : 'PowerPoint'
  const activity = op === 'outlook.calendar' ? 'Checking your calendar' : title === 'Outlook' ? 'Checking your mail' : 'Working with documents'
  const id = `office:${lane}`
  const entry: WorkPreviewDto = { id, lane, title, activity, at: Date.now(), captureState: 'activity', current: true }
  valid.set(id, () => true)
  entries.delete(id); entries.set(id, entry)
  for (const oldest of [...entries.values()].filter(frame => frame.lane === lane).slice(0, -4)) remove(oldest.id)
  while (entries.size > 64) remove(entries.keys().next().value!)
  publish()
  if (!timer) timer = setInterval(() => publish(true), 1000).unref()
  return () => { entry.current = false; publish() }
}
export function showWorkPreview(binding: DesktopBinding, working = true): void {
  if (quitting || keptOut(binding.name) || desktopBinding(binding.lane) !== binding || binding.host.closed || binding.stopped || !binding.readable) return
  hookPreviewEvents()
  if (working) active.add(binding.lane)
  const key = `${binding.lane}:${binding.source}`
  if (owners.has(key) && owners.get(key) !== binding || valid.has(key) && !valid.get(key)!()) remove(key)
  owners.set(key, binding)
  valid.set(key, () => {
    const current = desktopBinding(binding.lane)
    return !!current?.readable && !current.stopped && !binding.stopped && !binding.host.closed && !keptOut(binding.name)
      && (current === binding || !!entries.get(key)?.data)
  })
  const previous = entries.get(key)
  const entry: WorkPreviewDto = previous ?? { id: key, lane: binding.lane, title: binding.name, at: Date.now(), captureState: 'waiting' }
  entries.delete(key); entries.set(key, entry)
  const laneEntries = [...entries.values()].filter(frame => frame.lane === binding.lane)
  for (const oldest of laneEntries.slice(0, -4)) remove(oldest.id)
  while (entries.size > 64) remove(entries.keys().next().value!)
  if (entry.captureReason !== 'capture_unsafe') entry.captureState = entry.data ? 'delayed' : 'waiting'
  publish()
  if (!timer) timer = setInterval(() => publish(true), 1000).unref()
  if (streaming.has(binding.lane) || pending.has(key)) return
  if (entry.data && binding.host.busy && (preemptions.get(binding.lane) ?? 0) < 3 || Date.now() - (lastCapture.get(key) ?? 0) < (visible.has(binding.lane) ? 1400 : 2000) || pending.size >= 2) {
    if (!deferred.has(key)) deferred.set(key, setTimeout(() => {
      deferred.delete(key)
      if ((active.has(binding.lane) || visible.has(binding.lane)) && valid.get(key)?.()) showWorkPreview(binding, active.has(binding.lane))
    }, visible.has(binding.lane) ? 1500 : 2100).unref())
    return
  }
  const controller = new AbortController()
  pending.set(key, controller); lastCapture.set(key, Date.now())
  const started = Date.now()
  const timeout = setTimeout(() => controller.abort(), 8000)
  const protectedCapture = !entry.data || (preemptions.get(binding.lane) ?? 0) >= 3
  if (protectedCapture) preemptions.set(binding.lane, 0)
  let stage: 'observe' | 'capture' | 'verify' = 'observe', stageStarted = started
  const stages: Partial<Record<'observe' | 'capture' | 'verify', number>> = {}
  const nextStage = (next: typeof stage) => { stages[stage] = Date.now() - stageStarted; stage = next; stageStarted = Date.now() }
  void previewImage(binding, controller.signal, !protectedCapture, nextStage).then(result => {
    if (entries.get(key) !== entry || desktopBinding(binding.lane) !== binding || !valid.get(key)?.() || controller.signal.aborted || quitting) return
    preemptions.delete(binding.lane)
    transparentFailures.delete(binding)
    stages[stage] = Date.now() - stageStarted
    if (Date.now() - (lastSuccess.get(binding.lane) ?? -Infinity) >= 30_000) {
      lastSuccess.set(binding.lane, Date.now())
      flog('desktop-preview', JSON.stringify({ lane: binding.lane, source: binding.source, ms: Date.now() - started, stage, stages, reason: 'ok' }))
    }
    if (result.image) {
      entry.data = nativeImage.createFromBuffer(Buffer.from(result.image.data, 'base64')).resize({ width: 700 }).toDataURL()
      entry.at = Date.now(); entry.unavailable = false; entry.captureState = 'ready'; delete entry.captureReason
    } else { delete entry.data; entry.unavailable = true; entry.captureState = 'unavailable' }
  }).catch((error: unknown) => {
    const preempted = error instanceof Error && error.name === 'PreviewPreempted'
    if (preempted) preemptions.set(binding.lane, (preemptions.get(binding.lane) ?? 0) + 1)
    else preemptions.delete(binding.lane)
    const reason = preempted ? 'work-priority' : controller.signal.aborted ? 'cancelled-or-expired' : previewFailureReason(error)
    stages[stage] = Date.now() - stageStarted
    flog('desktop-preview', JSON.stringify({ lane: binding.lane, source: binding.source, ms: Date.now() - started, stage, stages, reason }))
    if (entries.get(key) !== entry || desktopBinding(binding.lane) !== binding) return
    if (!controller.signal.aborted && binding.hiddenByEngram && String(error).includes('has not drawn a preview yet')) {
      const failures = (transparentFailures.get(binding) ?? 0) + 1
      transparentFailures.set(binding, failures)
      if (failures === 3) {
        void restoreHiddenApp(binding.lane, false)
        flog('desktop-preview', JSON.stringify({ lane: binding.lane, source: binding.source, reason: 'hidden-fallback' }))
      }
    } else transparentFailures.delete(binding)
    if (preempted || controller.signal.aborted) {
      entry.current = false
      entry.captureState = entry.data ? 'delayed' : 'no-snapshot'
      if (preempted && (active.has(binding.lane) || visible.has(binding.lane)) && !streaming.has(binding.lane) && !deferred.has(key)) deferred.set(key, setTimeout(() => {
        deferred.delete(key)
        if ((active.has(binding.lane) || visible.has(binding.lane)) && valid.get(key)?.()) showWorkPreview(binding, active.has(binding.lane))
      }, visible.has(binding.lane) ? 1500 : 2100).unref())
    } else {
      delete entry.data; entry.unavailable = true; entry.captureState = 'unavailable'; entry.captureReason = previewFailureReason(error)
    }
  }).finally(() => {
    clearTimeout(timeout)
    if (pending.get(key) === controller) pending.delete(key)
    if (!quitting) publish()
  })
}

export function previewFailureReason(error: unknown): NonNullable<WorkPreviewDto['captureReason']> {
  const reason = error instanceof Error ? error.message : String(error)
  if (/Allow Engram in System Settings.*Screen Recording/i.test(reason)) return 'screen_recording_denied'
  if (/accessibility scan was incomplete|safe screenshot geometry|safely capture|captured safely|complete accessibility scan/i.test(reason)) return 'capture_unsafe'
  return 'capture_unavailable'
}
