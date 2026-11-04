import { flog } from './flog.js'
import { setWorkPreviewStream, workPreviews } from './work-preview.js'
import { ipcMain, session, systemPreferences, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopHost } from './desktop-host.js'
import { showDesktopApp, captureSource, chooseDesktop, desktopBindings, desktopOwner, desktopVisible, desktopWindows, releaseDesktop, setDesktopReadAccess } from './desktop-access.js'
import { desktopControlStatus, readControlledDesktop, resumeDesktopControl, startDesktopControl, stopDesktopFromUi } from './desktop-control.js'
import { overlayStatus, overlayWindowIds } from './desktop-overlay.js'
import { stopApplicationWork } from './application-work.js'

const requests = new Map<number, { lane: string; source: string; token: string; expires: number; capturing?: boolean }>()
function allowed(sender: WebContents): boolean { return desktopOwner()?.webContents === sender }
// The on-screen pill may stop or resume control; nothing else reaches it.
const FROM_OVERLAY = new Set(['desktop:controlStop', 'desktop:controlResume', 'desktop:controlStatus', 'desktop:overlayStatus'])
function allowedFrom(sender: WebContents, channel: string): boolean {
  return allowed(sender) || (FROM_OVERLAY.has(channel) && overlayWindowIds().includes(sender.id))
}
export function allowDesktopCapture(sender: WebContents | null, permission: string, details: { isMainFrame?: boolean; mediaTypes?: unknown } = {}): boolean {
  const request = sender && requests.get(sender.id)
  if (!sender || !allowed(sender) || !desktopVisible() || details.isMainFrame !== true || !request || request.expires <= Date.now()) return false
  // Older runtimes report display capture as media without physical devices.
  return permission === 'display-capture' || (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0)
}
export function registerDesktopIpc(): void {
  const handle = <Args extends unknown[]>(name: string, fn: (...args: Args) => unknown) => {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (!allowedFrom(event.sender, name) || event.senderFrame !== event.sender.mainFrame) throw new Error('App access is only available from the main window.')
      return fn(...args as Args)
    })
  }
  handle('desktop:available', () => DesktopHost.available())
  handle('desktop:visible', desktopVisible)
  handle('desktop:previews', workPreviews)
  handle('desktop:showApp', showDesktopApp)
  handle('desktop:previewStream', setWorkPreviewStream)
  handle('desktop:previewStreamEvent', (lane: string, detail: { event: string; reason?: string; attempt?: number }) => {
    if (typeof lane !== 'string' || !/^bot-[a-zA-Z0-9_-]{1,140}$/.test(lane) || !detail || !['start', 'live', 'retry', 'failed', 'ended'].includes(detail.event)
      || detail.reason !== undefined && (typeof detail.reason !== 'string' || detail.reason.length > 500)
      || detail.attempt !== undefined && (!Number.isInteger(detail.attempt) || detail.attempt < 0 || detail.attempt > 5)) throw new Error('Invalid preview stream event.')
    flog('desktop-stream', JSON.stringify({ lane, event: detail.event, reason: detail.reason, attempt: detail.attempt }))
  })
  handle('desktop:windows', desktopWindows)
  handle('desktop:bindings', desktopBindings)
  handle('desktop:choose', chooseDesktop)
  handle('desktop:release', releaseDesktop)
  handle('desktop:readAccess', setDesktopReadAccess)
  handle('desktop:observe', (lane: string) => readControlledDesktop(lane))
  handle('desktop:controlStatus', desktopControlStatus)
  handle('desktop:controlStart', startDesktopControl)
  handle('desktop:controlStop', () => { if (!stopApplicationWork()) stopDesktopFromUi() })
  handle('desktop:controlResume', resumeDesktopControl)
  handle('desktop:overlayStatus', overlayStatus)
  handle('desktop:prepare', (lane: string) => {
    const reject = (reason: string): never => { flog('desktop-stream', JSON.stringify({ lane, event: 'failed', reason })); throw new Error(reason) }
    if (!desktopVisible()) reject('Show Engram before starting a window view.')
    const sender = desktopOwner()!.webContents
    const binding = desktopBindings().find((item) => item.lane === lane)
    if (!binding) return reject('Connect an app window before starting its live view.')
    if ((requests.get(sender.id)?.expires ?? 0) > Date.now()) return reject('A live view is already starting. Try again.')
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') { flog('desktop-stream', JSON.stringify({ lane, event: 'failed', reason: 'screen_recording_denied' })); return { denied: 'screen_recording' } }
    const token = randomUUID()
    requests.set(sender.id, { lane, source: binding.source, token, expires: Date.now() + 10000 })
    return token
  })
  handle('desktop:cancelCapture', (token: string) => {
    const sender = desktopOwner()!.webContents
    if (requests.get(sender.id)?.token === token) requests.delete(sender.id)
  })
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const sender = desktopOwner()?.webContents
    const pending = sender && requests.get(sender.id)
    if (!sender || !desktopVisible() || request.frame !== sender.mainFrame || request.audioRequested || !pending || pending.capturing || pending.expires <= Date.now()) { flog('desktop-stream', JSON.stringify({ lane: pending?.lane, event: 'failed', reason: 'invalid-display-request' })); callback(null as unknown as Electron.Streams); return }
    pending.capturing = true
    let answered = false
    const finish = (source?: Awaited<ReturnType<typeof captureSource>>, reason = 'capture-request-changed'): void => {
      if (answered) return
      answered = true
      const current = requests.get(sender.id) === pending
      if (current) requests.delete(sender.id)
      if (!current || !source) flog('desktop-stream', JSON.stringify({ lane: pending.lane, source: pending.source, event: 'failed', reason }))
      // Electron 33 accepts null for denial; an empty object throws after rejecting capture.
      callback(current && source ? { video: source } : null as unknown as Electron.Streams)
    }
    void captureSource(pending.lane).then((source) => {
      if (desktopOwner()?.webContents !== sender || !desktopVisible() || sender.isDestroyed() || request.frame !== sender.mainFrame || pending.expires <= Date.now() || source.id !== pending.source || !desktopBindings().some((item) => item.lane === pending.lane && item.source === source.id)) { finish(); return }
      finish(source)
    }).catch(error => finish(undefined, error instanceof Error ? error.message : 'capture-source-failed'))
  })
}
