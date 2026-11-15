import { BrowserWindow } from 'electron'

// A message box with no window is app-modal on macOS: it runs its own loop on
// the main thread and the whole app stops until it is answered (QA 0.8.142 B6
// froze for ~10 minutes). Asking is always a sheet on Engram's visible window;
// with none on screen the caller declines instead.
export function visibleDialogOwner(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && focused.isVisible()) return focused
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.isVisible())
}
