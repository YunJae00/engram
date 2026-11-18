import { BrowserWindow } from 'electron'

function visibleDialogOwner(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused.isVisible()) return focused
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.isVisible())
}

let surface: () => BrowserWindow | undefined = () => undefined
export function setDialogSurface(next: typeof surface): void { surface = next }
if (process.defaultApp && process.env['ENGRAM_HIDDEN'] === '1') Object.assign(globalThis, { __engramDialogSurface: setDialogSurface })
export function askOwner(): BrowserWindow | undefined {
  const visible = visibleDialogOwner()
  if (visible) return visible
  const window = surface()
  return window && !window.isDestroyed() ? window : undefined
}
