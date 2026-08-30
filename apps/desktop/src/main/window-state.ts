import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The main window takes the whole desk the first time it opens - a window
// with a page mirrored inside it wants the room - and after that comes back
// where the person last left it, at the size they chose.

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

const SAVE_AFTER_MS = 500

function file(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export async function loadWindowState(): Promise<WindowState> {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as WindowState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// A remembered place is only honoured while some screen still shows it; a
// window left on a monitor that is gone would otherwise open out of reach.
function visible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
  })
}

export function placeWindow(win: BrowserWindow, state: WindowState): void {
  const remembered = state.bounds && visible(state.bounds) ? state.bounds : null
  if (remembered) win.setBounds(remembered)
  if (state.maximized ?? true) win.maximize()
}

export function keepWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed()) return
      const next: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      void writeFile(file(), JSON.stringify(next)).catch(() => undefined)
    }, SAVE_AFTER_MS)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
}
