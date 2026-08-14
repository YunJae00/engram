import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { broadcast } from './ipc.js'

const COLLAPSED = { width: 56, height: 56 }
const EXPANDED = { width: 440, height: 640 }
const MARGIN = 16

interface BubbleState {
  x?: number
  y?: number
  // Hidden via the tray toggle. The default is visible: the button being
  // discoverable without reading any docs is its entire reason to exist.
  hidden?: boolean
}

let win: BrowserWindow | null = null
let state: BubbleState = {}
let expanded = false

function stateFile(): string {
  return join(app.getPath('userData'), 'bubble-state.json')
}

async function loadState(): Promise<void> {
  try {
    state = JSON.parse(await readFile(stateFile(), 'utf8')) as BubbleState
  } catch {
    state = {}
  }
}

function saveState(): void {
  void writeFile(stateFile(), JSON.stringify(state)).catch(() => undefined)
}

function clamp(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - w),
    y: Math.min(Math.max(y, area.y), area.y + area.height - h),
  }
}

function defaultSpot(): { x: number; y: number } {
  // Bottom-right, above the taskbar — where a person expects a helper to sit.
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - COLLAPSED.width - MARGIN,
    y: area.y + area.height - COLLAPSED.height - MARGIN - 8,
  }
}

export function isBubbleVisible(): boolean {
  return win !== null && !win.isDestroyed() && win.isVisible()
}

export function setBubbleVisible(visible: boolean): void {
  state.hidden = !visible
  saveState()
  if (!win || win.isDestroyed()) return
  if (visible) win.showInactive()
  else win.hide()
}

export async function startBubble(deps: {
  webPreferences: Electron.WebPreferences
  loadRenderer: (w: BrowserWindow, hash: string) => Promise<void>
  harden: (wc: Electron.WebContents) => void
  showMainWindow: () => void
  onQuit: () => void
}): Promise<void> {
  await loadState()
  const spot = clamp(state.x ?? defaultSpot().x, state.y ?? defaultSpot().y, COLLAPSED.width, COLLAPSED.height)
  win = new BrowserWindow({
    ...COLLAPSED,
    ...spot,
    frame: false,
    resizable: false,
    // Explicit even though it is the default: dragging is the feature.
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: deps.webPreferences,
  })
  deps.harden(win.webContents)
  await deps.loadRenderer(win, 'bubble')
  // Wherever the user drags it is where it lives — collapsed position only;
  // the expanded chat is a temporary shape, not a home. Debounced: the JS
  // drag path emits a move per pointer event, and a settle is one write.
  let saveTimer: NodeJS.Timeout | null = null
  win.on('moved', () => {
    if (!win || expanded) return
    const [x, y] = win.getPosition()
    state.x = x
    state.y = y
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 400)
  })
  if (state.hidden !== true) win.showInactive()

  ipcMain.handle('bubble:expand', () => {
    if (!win || win.isDestroyed()) return
    const [bx = 0, by = 0] = win.getPosition()
    // Grow up-left from the button so the corner the user knows stays put.
    const { x, y } = clamp(
      bx + COLLAPSED.width - EXPANDED.width,
      by + COLLAPSED.height - EXPANDED.height,
      EXPANDED.width,
      EXPANDED.height,
    )
    expanded = true
    win.setBounds({ x, y, ...EXPANDED })
    win.focus()
  })

  ipcMain.handle('bubble:collapse', () => {
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    // The button lands where the chat's bottom-right corner was.
    const { x, y } = clamp(
      bounds.x + bounds.width - COLLAPSED.width,
      bounds.y + bounds.height - COLLAPSED.height,
      COLLAPSED.width,
      COLLAPSED.height,
    )
    expanded = false
    win.setBounds({ x, y, ...COLLAPSED })
    state.x = x
    state.y = y
    saveState()
    win.blur()
  })

  ipcMain.handle('bubble:openNote', (_e, id: string) => {
    deps.showMainWindow()
    broadcast({ type: 'note:open', id })
  })

  // Collapsed-dot drag (renderer pointer deltas): app-region drag was
  // unusable here — it swallows clicks, and the click IS the button.
  ipcMain.on('bubble:drag', (_e, dx: number, dy: number) => {
    if (!win || win.isDestroyed() || expanded) return
    const [x = 0, y = 0] = win.getPosition()
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  // The renderer has already asked "really quit?" — this is the yes.
  ipcMain.handle('bubble:quit', () => deps.onQuit())
}

export function stopBubble(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  expanded = false
}
