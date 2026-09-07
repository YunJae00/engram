import { ipcMain, session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopHost } from './desktop-host.js'
import { captureSource, chooseDesktop, desktopBindings, desktopOwner, desktopVisible, desktopWindows, observeDesktop, releaseDesktop, setDesktopReadAccess } from './desktop-access.js'

const requests = new Map<number, { lane: string; source: string; token: string; expires: number }>()
function allowed(sender: WebContents): boolean { return desktopOwner()?.webContents === sender }
export function allowDesktopCapture(sender: WebContents | null, permission: string, details: { isMainFrame?: boolean; mediaTypes?: unknown } = {}): boolean {
  const request = sender && requests.get(sender.id)
  if (!sender || !allowed(sender) || !desktopVisible() || details.isMainFrame !== true || !request || request.expires <= Date.now()) return false
  // Older runtimes report display capture as media without physical devices.
  return permission === 'display-capture' || (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0)
}
export function registerDesktopIpc(): void {
  const handle = <Args extends unknown[]>(name: string, fn: (...args: Args) => unknown) => {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (!allowed(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('App access is only available from the main window.')
      return fn(...args as Args)
    })
  }
  handle('desktop:available', () => DesktopHost.available())
  handle('desktop:visible', desktopVisible)
  handle('desktop:windows', desktopWindows)
  handle('desktop:bindings', desktopBindings)
  handle('desktop:choose', chooseDesktop)
  handle('desktop:release', releaseDesktop)
  handle('desktop:readAccess', setDesktopReadAccess)
  handle('desktop:observe', observeDesktop)
  handle('desktop:prepare', (lane: string) => {
    if (!desktopVisible()) throw new Error('Show Engram before starting a window view.')
    const sender = desktopOwner()!.webContents
    const binding = desktopBindings().find((item) => item.lane === lane)
    if (!binding) throw new Error('Connect an app window before starting its live view.')
    if ((requests.get(sender.id)?.expires ?? 0) > Date.now()) throw new Error('A live view is already starting. Try again.')
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
    if (!sender || !desktopVisible() || request.frame !== sender.mainFrame || request.audioRequested || !pending || pending.expires < Date.now()) { callback({}); return }
    requests.delete(sender.id)
    void captureSource(pending.lane).then((source) => {
      if (desktopOwner()?.webContents !== sender || !desktopVisible() || sender.isDestroyed() || request.frame !== sender.mainFrame || pending.expires < Date.now() || source.id !== pending.source || !desktopBindings().some((item) => item.lane === pending.lane && item.source === source.id)) { callback({}); return }
      callback({ video: source })
    }).catch(() => callback({}))
  })
}
