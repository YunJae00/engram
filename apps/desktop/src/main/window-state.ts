import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Start compact, then remember the size and position the person chooses.

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

const SAVE_AFTER_MS = 500
// The share of the work area a first window takes, centred on it.
const FIRST_WIDTH = 1000

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
    const unit = Math.max(1, Math.floor(Math.min(FIRST_WIDTH / 4, area.width * 0.86 / 4, area.height * 0.9 / 3)))
    const width = unit * 4, height = unit * 3
    const [minWidth = 0, minHeight = 0] = win.getMinimumSize()
    if (width < minWidth || height < minHeight) win.setMinimumSize(Math.min(minWidth, width), Math.min(minHeight, height))
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
