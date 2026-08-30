import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The main window opens over most of the desk the first time - a window
// with a page mirrored inside it wants the room, and a window that fills
// the screen stops feeling like one - and after that comes back where the
// person last left it, at the size they chose.

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

const SAVE_AFTER_MS = 500
// The share of the work area a first window takes, centred on it.
const FIRST_SHARE = { width: 0.86, height: 0.9 }

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
  else {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.max(win.getMinimumSize()[0] ?? 0, Math.round(area.width * FIRST_SHARE.width))
    const height = Math.max(win.getMinimumSize()[1] ?? 0, Math.round(area.height * FIRST_SHARE.height))
    win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height })
  }
  if (state.maximized) win.maximize()
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
