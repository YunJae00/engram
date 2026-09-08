import { BrowserWindow, desktopCapturer, dialog, type DesktopCapturerSource } from 'electron'
import type { DesktopBindingDto, DesktopWindowDto } from '../shared/desktop.js'
import { DesktopHost } from './desktop-host.js'
import { broadcast } from './engine-health.js'

export interface DesktopBinding extends DesktopBindingDto { window: string; pid: number; host: DesktopHost; stopped: boolean; revision: number }
type Binding = DesktopBinding
const bindings = new Map<string, Binding>()
const choices = new Map<string, number>()
let generation = 0
let owner: BrowserWindow | undefined
let releaseControl: (lane: string, reason: string) => void = () => undefined
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
  if (!binding) throw new Error('Choose an app window in Orbit first.')
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
  const host = new DesktopHost((reason) => {
    if (bindings.get(lane)?.host === host) {
      releaseControl(lane, reason)
      const binding = bindings.get(lane)!
      binding.readable = false
      binding.stopped = host.closed
      binding.revision++
      changed()
    }
  })
  try {
    const identity = await host.request<{ pid: number; title: string }>('inspectWindow', { window, pid: 0 })
    if (host.closed) throw new Error('This app connection ended. Reconnect the app window to continue.')
    if (generation !== epoch || choices.get(lane) !== choice) throw new Error('This window selection was cancelled.')
    // Recheck after enumeration so concurrent selections cannot share a window.
    if ([...bindings.values()].some((binding) => binding.source === sourceId && binding.lane !== lane)) throw new Error('This window was connected to another chat.')
    if (!bindings.has(lane) && bindings.size >= 4) throw new Error('Up to four app windows can be connected at once.')
    releaseControl(lane, 'The selected app window changed.')
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
  if (!enabled) releaseControl(lane, 'AI access was turned off.')
  const revision = ++binding.revision
  if (enabled && (binding.stopped || binding.host.closed)) throw new Error('This app connection ended. Reconnect the app window to continue.')
  if (enabled && !binding.readable) {
    const window = desktopOwner()
    if (!window) throw new Error('Open Engram to allow AI read access.')
    const reply = await dialog.showMessageBox(window, {
      type: 'question', title: 'AI read access', message: `Allow this chat to read ${binding.name}?`,
      detail: 'This chat may send text and screenshots from this selected window to your connected AI. Its contents may include sensitive information; close anything you do not want shared. This grants reading only, not mouse or keyboard control. Access ends when disabled, disconnected, or Engram quits.',
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
