import { BrowserWindow, desktopCapturer, type DesktopCapturerSource } from 'electron'
import type { DesktopBindingDto, DesktopWindowDto } from '../shared/desktop.js'
import { DesktopHost } from './desktop-host.js'
import { broadcast } from './engine-health.js'

export interface DesktopBinding extends DesktopBindingDto { window: string; pid: number; host: DesktopHost; stopped: boolean; revision: number }
type Binding = DesktopBinding
interface NativeWindow { window: string; pid: number; title: string; minimized: boolean; foreground?: boolean }
const bindings = new Map<string, Binding>()
const choices = new Map<string, number>()
let generation = 0
let owner: BrowserWindow | undefined
let releaseControl: (lane: string, reason: string) => void = () => undefined
const LANE = /^bot-[a-zA-Z0-9_-]{1,140}$/
export function setDesktopReleaseHook(hook: typeof releaseControl): void { releaseControl = hook }
export function desktopBinding(lane: string): Binding | undefined { return bindings.get(lane) }
export function desktopChanged(): void { changed() }
export function setDesktopOwner(window: BrowserWindow): void {
  owner = window
  window.on('closed', closeDesktopAccess)
  window.webContents.on('render-process-gone', closeDesktopAccess)
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) closeDesktopAccess() })
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
  return [...bindings.values()].map(({ lane, source, name, readable, stopped }) => ({ lane, source, name, readable, stopped }))
}
export function closeDesktopAccess(): void { generation++; for (const key of [...bindings.keys()]) releaseDesktop(key) }
export function releaseDesktop(lane: string): void {
  releaseControl(lane, 'The app window was disconnected.')
  choices.set(lane, (choices.get(lane) ?? 0) + 1)
  bindings.get(lane)?.host.close()
  bindings.delete(lane)
  changed()
}
function bound(lane: string): Binding {
  const binding = bindings.get(lane)
  if (!binding) throw new Error('No app is connected to this chat yet.')
  return binding
}
// The host's revocations reach control through the release hook; whether a
// pause is one the comet may resume is control's call, so readability is left
// alone here. A closed host is terminal either way.
function hostFor(lane: string): DesktopHost {
  const host: DesktopHost = new DesktopHost((reason) => {
    const binding = bindings.get(lane)
    if (binding?.host !== host) return
    releaseControl(lane, reason)
    binding.stopped = host.closed
    binding.revision++
    changed()
  })
  return host
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
  if (!DesktopHost.available()) return []
  const host = [...bindings.values()].find((binding) => !binding.host.closed)?.host ?? hostFor('')
  try { return (await nativeWindows(host)).map((one) => ({ id: `window:${one.window}:0`, name: one.title, ...(one.foreground ? { foreground: true } : {}) })) }
  finally { if (![...bindings.values()].some((binding) => binding.host === host)) host.close() }
}
async function nativeWindows(host: DesktopHost): Promise<NativeWindow[]> {
  const own = new Set(BrowserWindow.getAllWindows().map((window) => window.getNativeWindowHandle().readBigUInt64LE().toString()))
  const result = await host.request<{ windows?: NativeWindow[] }>('listWindows', {})
  return (result?.windows ?? []).filter((one) => typeof one?.window === 'string' && !own.has(one.window) && typeof one.title === 'string')
}
// The comet's own choice of window: the one named by a word from its title,
// else the one in front. No picker, no dialog - reading it is the grant.
export async function bindDesktopForLane(lane: string, pick: { app?: string } = {}): Promise<Binding> {
  const epoch = generation
  if (typeof lane !== 'string' || !LANE.test(lane)) throw new Error('Choose a valid chat first.')
  const current = bindings.get(lane)
  if (current && !pick.app && !current.stopped && !current.host.closed) { current.readable = true; return current }
  const host = current && !current.stopped && !current.host.closed ? current.host : hostFor(lane)
  const choice = (choices.get(lane) ?? 0) + 1
  choices.set(lane, choice)
  try {
    const windows = await nativeWindows(host)
    const wanted = pick.app?.trim().toLocaleLowerCase()
    const candidates = wanted ? windows.filter((one) => one.title.toLocaleLowerCase().includes(wanted)) : windows.filter((one) => one.foreground)
    const target = candidates.find((one) => !one.minimized && one.foreground) ?? candidates.find((one) => !one.minimized) ?? candidates[0]
    if (!target) throw new Error(wanted ? `No open window matches "${pick.app}". Open that app first, or call list_windows to see what is open.` : 'No app window is in front to work in. Name one with app, or open it first.')
    if (generation !== epoch || choices.get(lane) !== choice) throw new Error('This window selection was cancelled.')
    const taken = [...bindings.values()].find((binding) => !binding.host.closed && binding.window === target.window && binding.lane !== lane)
    if (taken) throw new Error(`"${target.title}" belongs to another chat right now.`)
    if (current?.window === target.window && current.host === host) { current.readable = true; current.name = target.title || current.name; return current }
    if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
    if (current && current.host !== host) current.host.close()
    const binding: Binding = { lane, source: `window:${target.window}:0`, name: target.title, readable: true, window: target.window, pid: target.pid, host, stopped: false, revision: (current?.revision ?? 0) + 1 }
    bindings.set(lane, binding)
    changed()
    return binding
  } catch (error) { if (!current || current.host !== host) host.close(); throw error }
}
export async function chooseDesktop(lane: string, sourceId: string): Promise<DesktopBindingDto> {
  const epoch = generation
  if (typeof lane !== 'string' || !LANE.test(lane)) throw new Error('Choose a valid chat first.')
  if (typeof sourceId !== 'string' || !/^window:\d+:\d+$/.test(sourceId)) throw new Error('Choose a valid app window.')
  if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
  if ([...bindings.values()].some((binding) => !binding.host.closed && binding.source === sourceId && binding.lane !== lane)) throw new Error('This window already belongs to another chat. Choose a different window.')
  const choice = (choices.get(lane) ?? 0) + 1
  choices.set(lane, choice)
  const window = /^window:(\d+):/.exec(sourceId)![1]!
  const host = hostFor(lane)
  try {
    const identity = await host.request<{ pid: number; title: string }>('inspectWindow', { window, pid: 0 })
    if (host.closed) throw new Error('This app connection ended. Reconnect the app window to continue.')
    if (generation !== epoch || choices.get(lane) !== choice) throw new Error('This window selection was cancelled.')
    // Recheck after enumeration so concurrent selections cannot share a window.
    if ([...bindings.values()].some((binding) => !binding.host.closed && binding.source === sourceId && binding.lane !== lane)) throw new Error('This window was connected to another chat.')
    if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
    releaseControl(lane, 'The selected app window changed.')
    bindings.get(lane)?.host.close()
    const binding: Binding = { lane, source: sourceId, name: identity.title || sourceId, readable: false, window, pid: identity.pid, host, stopped: false, revision: 0 }
    bindings.set(lane, binding)
    changed()
    return desktopBindings().find((item) => item.lane === lane)!
  } catch (error) { host.close(); throw error }
}
export async function setDesktopReadAccess(lane: string, enabled: boolean): Promise<DesktopBindingDto> {
  if (typeof enabled !== 'boolean') throw new Error('AI read access must be explicitly enabled or disabled.')
  const binding = bound(lane)
  if (!enabled) releaseControl(lane, 'AI access was turned off.')
  binding.revision++
  if (enabled && (binding.stopped || binding.host.closed)) throw new Error('This app connection ended. Reconnect the app window to continue.')
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
