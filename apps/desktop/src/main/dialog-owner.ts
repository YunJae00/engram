import { BrowserWindow } from 'electron'

// A message box with no window is app-modal on macOS: it runs its own loop on
// the main thread and the whole app stops until it is answered (QA 0.8.142 B6
// froze for ~10 minutes). Asking is always a sheet on Engram's visible window;
// with none on screen the caller declines instead.
function visibleDialogOwner(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused.isVisible()) return focused
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.isVisible())
}

// When Engram is in the background its main window is brought forward and the
// question is a sheet on it (hidden test runs keep it unshown). The host sets
// how; without one, nothing is asked.
let surface: () => BrowserWindow | undefined = () => undefined
export function setDialogSurface(next: typeof surface): void { surface = next }
// Hidden development runs (e2e) stub the dialog and may name the window to ask on.
if (process.defaultApp && process.env['ENGRAM_HIDDEN'] === '1') Object.assign(globalThis, { __engramDialogSurface: setDialogSurface })
export function askOwner(): BrowserWindow | undefined {
  const visible = visibleDialogOwner()
  if (visible) return visible
  const window = surface()
  return window && !window.isDestroyed() ? window : undefined
}
