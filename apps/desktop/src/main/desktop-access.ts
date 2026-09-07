import { BrowserWindow, desktopCapturer, dialog, type DesktopCapturerSource } from 'electron'
import { desktopTools, type AgentTool } from 'core'
import type { DesktopBindingDto, DesktopObservationDto, DesktopWindowDto } from '../shared/desktop.js'
import { DesktopHost } from './desktop-host.js'
import { broadcast } from './engine-health.js'

interface Binding extends DesktopBindingDto { window: string; pid: number; host: DesktopHost; stopped: boolean; revision: number }
const bindings = new Map<string, Binding>()
const choices = new Map<string, number>()
let generation = 0
let owner: BrowserWindow | undefined
export function setDesktopOwner(window: BrowserWindow): void {
  owner = window
  window.on('closed', closeDesktopAccess)
  window.webContents.on('render-process-gone', closeDesktopAccess)
  const visibility = () => broadcast({ type: 'desktop:visibility', visible: desktopVisible() })
  window.on('show', visibility)
  window.on('hide', visibility)
  window.on('minimize', visibility)
  window.on('restore', visibility)
}
export function desktopOwner(): BrowserWindow | undefined { return owner && !owner.isDestroyed() ? owner : undefined }
export function desktopVisible(): boolean { const window = desktopOwner(); return Boolean(window?.isVisible() && !window.isMinimized()) }
const changed = () => broadcast({ type: 'desktop:changed' })
export function desktopBindings(): DesktopBindingDto[] {
  return [...bindings.values()].map(({ lane, source, name, readable }) => ({ lane, source, name, readable }))
}
export function closeDesktopAccess(): void { generation++; for (const key of [...bindings.keys()]) releaseDesktop(key) }
export function releaseDesktop(lane: string): void {
  choices.set(lane, (choices.get(lane) ?? 0) + 1)
  bindings.get(lane)?.host.close()
  bindings.delete(lane)
  changed()
}
function bound(lane: string, readable = false): Binding {
  const binding = bindings.get(lane)
  if (!binding) throw new Error('Choose an app window in Orbit first.')
  if (readable && !binding.readable) throw new Error('Enable AI read access for this chat in Orbit first.')
  return binding
}
export async function desktopSources(): Promise<DesktopCapturerSource[]> {
  if (!DesktopHost.available()) return []
  const own = new Set(BrowserWindow.getAllWindows().map((window) => window.getNativeWindowHandle().readBigUInt64LE().toString()))
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
  return sources.filter((source) => {
    const id = /^window:(\d+):/.exec(source.id)?.[1]
    return id && !own.has(id)
  })
}
export async function desktopWindows(): Promise<DesktopWindowDto[]> {
  return (await desktopSources()).map(({ id, name }) => ({ id, name }))
}
export async function chooseDesktop(lane: string, sourceId: string): Promise<DesktopBindingDto> {
  const epoch = generation
  if (typeof lane !== 'string' || !/^bot-[a-zA-Z0-9_-]{1,140}$/.test(lane)) throw new Error('Choose a valid chat first.')
  if (typeof sourceId !== 'string' || !/^window:\d+:\d+$/.test(sourceId)) throw new Error('Choose a valid app window.')
  if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
  if ([...bindings.values()].some((binding) => binding.source === sourceId && binding.lane !== lane)) throw new Error('This window already belongs to another chat. Choose a different window.')
  const choice = (choices.get(lane) ?? 0) + 1
  choices.set(lane, choice)
  const source = (await desktopSources()).find((item) => item.id === sourceId)
  if (!source) throw new Error('This window is no longer available. Refresh the list.')
  const window = /^window:(\d+):/.exec(source.id)![1]!
  const host = new DesktopHost()
  try {
    const identity = await host.request<{ pid: number; title: string }>('inspectWindow', { window, pid: 0 })
    if (generation !== epoch || choices.get(lane) !== choice) throw new Error('This window selection was cancelled.')
    // Recheck after enumeration so concurrent selections cannot share a window.
    if ([...bindings.values()].some((binding) => binding.source === sourceId && binding.lane !== lane)) throw new Error('This window was connected to another chat.')
    if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
    bindings.get(lane)?.host.close()
    const binding: Binding = { lane, source: source.id, name: identity.title || source.name, readable: false, window, pid: identity.pid, host, stopped: false, revision: 0 }
    bindings.set(lane, binding)
    changed()
    return desktopBindings().find((item) => item.lane === lane)!
  } catch (error) { host.close(); throw error }
}
export async function setDesktopReadAccess(lane: string, enabled: boolean): Promise<DesktopBindingDto> {
  if (typeof enabled !== 'boolean') throw new Error('AI read access must be explicitly enabled or disabled.')
  const binding = bound(lane)
  const revision = ++binding.revision
  if (enabled && binding.stopped) throw new Error('Choose the app window again to start a new access session.')
  if (enabled && !binding.readable) {
    const window = desktopOwner()
    if (!window) throw new Error('Open Engram to allow AI read access.')
    const reply = await dialog.showMessageBox(window, {
      type: 'question', title: 'AI read access', message: `Allow this chat to read ${binding.name}?`,
      detail: 'Accessible text from this window may be sent as plain text to your connected AI when this chat uses the read tool. This access is read-only: Engram cannot click, edit, scroll or type in the app. Password fields are excluded. Access lasts for this session and ends when you turn it off, disconnect the window or quit Engram.',
      buttons: ['Cancel', 'Allow for this session'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (reply.response !== 1) throw new Error('AI read access was not enabled.')
    if (bindings.get(lane) !== binding || binding.revision !== revision) throw new Error('The AI read access request was cancelled. Try again.')
  }
  binding.readable = enabled
  changed()
  return desktopBindings().find((item) => item.lane === lane)!
}
export async function captureSource(lane: string): Promise<DesktopCapturerSource> {
  const binding = bound(lane)
  await binding.host.request('inspectWindow', { window: binding.window, pid: binding.pid })
  const source = (await desktopSources()).find((item) => item.id === binding.source)
  if (!source || bindings.get(lane) !== binding) throw new Error('The connected window is no longer available.')
  return source
}
export async function observeDesktop(lane: string, signal?: AbortSignal): Promise<DesktopObservationDto> {
  signal?.throwIfAborted()
  const binding = bound(lane, true)
  const revision = binding.revision
  try {
    const result = await binding.host.request<DesktopObservationDto>('observe', { window: binding.window, pid: binding.pid })
    signal?.throwIfAborted()
    if (bindings.get(lane) !== binding || !binding.readable || binding.revision !== revision) throw new Error('AI read access ended.')
    return result
  } catch (error) {
    if (error instanceof Error && /stopped responding|connection closed|App sharing stopped|replaced|no longer available/i.test(error.message)) pause(binding)
    throw error
  }
}
function pause(binding: Binding): void {
  binding.readable = false; binding.stopped = true; binding.revision++
  binding.host.close(); changed()
}
export function desktopAgentTools(lane: string): AgentTool[] {
  if (!bindings.get(lane)?.readable) return []
  return desktopTools({
    read: async (signal) => JSON.stringify(await observeDesktop(lane, signal)),
  })
}
