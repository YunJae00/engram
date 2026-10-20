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
// Apps the person keeps out of reach, by the name their windows end with.
let labelsOff: string[] = []
export function setDesktopAppsOff(labels: string[]): void {
  labelsOff = labels.map(label => label.toLowerCase())
  generation++
  for (const binding of bindings.values()) if (keptOut(binding.name)) releaseDesktop(binding.lane)
}
export function keptOut(title: string): string | undefined {
  const tail = title.split(/\s+[-|—–]\s+/).at(-1)?.trim().toLowerCase() ?? ''
  return labelsOff.find(label => label === tail || label === title.trim().toLowerCase())
}
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
export function closeDesktopAccess(): void { generation++; for (const key of [...bindings.keys()]) releaseDesktop(key); closeCatalogHost() }
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
// The helper that answers catalog questions (open windows, launchable apps) stays up for a
// while after each answer: starting one costs 1-6s on a loaded machine, answering costs 0.1s.
const CATALOG_IDLE_MS = 90_000
let catalog: { host: DesktopHost; timer: ReturnType<typeof setTimeout> } | null = null
export function catalogHost(): DesktopHost {
  const bound = [...bindings.values()].find((binding) => !binding.host.closed)?.host
  if (bound) return bound
  if (catalog && catalog.host.closed) { clearTimeout(catalog.timer); catalog = null }
  if (!catalog) {
    const host = new DesktopHost(() => undefined)
    catalog = { host, timer: setTimeout(() => { if (catalog?.host === host) { catalog = null; host.close() } }, CATALOG_IDLE_MS) }
  } else {
    clearTimeout(catalog.timer)
    const held = catalog
    held.timer = setTimeout(() => { if (catalog === held) { catalog = null; held.host.close() } }, CATALOG_IDLE_MS)
  }
  catalog.timer.unref?.()
  return catalog.host
}
export function closeCatalogHost(): void { if (catalog) { clearTimeout(catalog.timer); catalog.host.close(); catalog = null } }
export async function desktopWindows(): Promise<DesktopWindowDto[]> {
  if (!DesktopHost.available()) return []
  return (await nativeWindows(catalogHost())).map((one) => ({ id: `window:${one.window}:0`, name: one.title, ...(one.foreground ? { foreground: true } : {}) }))
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
    // The open windows travel with the miss, so the next call can name one without a separate listing.
    const open = windows.map((one) => one.title).filter(Boolean).slice(0, 40).map((title) => `"${title}"`).join(', ')
    if (!target) throw new Error(wanted ? `No open window matches "${pick.app}". Open windows: ${open || 'none'}. Use a word from one of these titles, or open the app with open_app.` : `No app window is in front to work in. Open windows: ${open || 'none'}. Name one with app, or open it first.`)
    if (generation !== epoch || choices.get(lane) !== choice) throw new Error('This window selection was cancelled.')
    if (keptOut(target.title)) throw new Error(`The person keeps "${target.title}" out of Engram's reach in Settings. Do not work in it; say so, and that they can allow it in Settings.`)
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
    if (keptOut(identity.title)) throw new Error('This app is turned off in Settings.')
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
