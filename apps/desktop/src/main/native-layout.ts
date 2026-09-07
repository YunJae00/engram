import { BrowserWindow, ipcMain, screen } from 'electron'
import type { NativeSurfaceDto } from '../shared/types.js'
import { lanePage } from './agent-browser.js'
import { isNativePage, nativeBrowserEnabled, nativeTarget, placeNativePages, setNativeBrowserOwner } from './native-browser.js'

let window: BrowserWindow | null = null
let revision = 0
let expires = 0
let visible = false
let registered = false

export function nativePagesVisible(): boolean { return visible && Date.now() < expires }

export function normalizeNativeSurfaces(value: unknown, width: number, height: number): NativeSurfaceDto[] {
  if (!Array.isArray(value)) return []
  const found = new Map<string, NativeSurfaceDto>()
  for (const item of value.slice(0, 16)) {
    if (!item || typeof item !== 'object') continue
    const rect = item as NativeSurfaceDto
    if (typeof rect.lane !== 'string' || !rect.lane.length || rect.lane.length > 160) continue
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y)
    const right = Math.min(width, rect.x + rect.width), bottom = Math.min(height, rect.y + rect.height)
    if (right - x < 16 || bottom - y < 16) continue
    if (rect.clip) {
      const clip = rect.clip
      if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || rect.width > 16000 || rect.height > 16000) continue
      const left = Math.max(x, rect.x + Math.max(0, clip.x)), top = Math.max(y, rect.y + Math.max(0, clip.y))
      const end = Math.min(right, rect.x + clip.x + clip.width), foot = Math.min(bottom, rect.y + clip.y + clip.height)
      if (end - left < 16 || foot - top < 16) continue
      found.set(rect.lane, { lane: rect.lane, x: rect.x, y: rect.y, width: rect.width, height: rect.height, clip: { x: left - rect.x, y: top - rect.y, width: end - left, height: foot - top } })
    } else found.set(rect.lane, { lane: rect.lane, x, y, width: right - x, height: bottom - y })
  }
  return [...found.values()].slice(-4)
}

async function layout(requested: unknown): Promise<void> {
  const generation = ++revision
  const win = window
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
    visible = false
    await placeNativePages([])
    return
  }
  const [width = 0, height = 0] = win.getContentSize()
  const zoom = win.webContents.getZoomFactor()
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor * zoom
  const rects = normalizeNativeSurfaces(requested, width / zoom, height / zoom)
  const views = await Promise.all(rects.map(async (rect) => {
    const page = lanePage(rect.lane)
    if (!page || !isNativePage(page)) return null
    const target = await nativeTarget(page).catch(() => null)
    if (!target || page.isClosed()) return null
    const clip = rect.clip ? Object.fromEntries(Object.entries(rect.clip).map(([key, value]) => [key, Math.round(value * scale)])) as NonNullable<NativeSurfaceDto['clip']> : undefined
    return { target, x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), ...(clip ? { clip } : {}) }
  }))
  if (generation !== revision) return
  visible = views.some(Boolean)
  await placeNativePages(views.filter((view): view is NonNullable<typeof view> => view !== null))
}

export function attachNativeLayout(win: BrowserWindow): void {
  registerNativeLayout()
  window = win
  setNativeBrowserOwner(win)
  const hide = () => { visible = false; expires = 0; ++revision; void placeNativePages([]).catch(() => undefined) }
  win.on('hide', hide)
  win.on('minimize', hide)
  win.webContents.on('did-start-loading', hide)
  win.webContents.on('render-process-gone', hide)
  const timer = setInterval(() => { if (visible && Date.now() > expires) hide() }, 1000).unref()
  win.once('closed', () => { clearInterval(timer); hide(); if (window === win) window = null })
}

export function registerNativeLayout(): void {
  if (registered) return
  registered = true
  ipcMain.handle('native:enabled', () => nativeBrowserEnabled())
  ipcMain.handle('native:layout', async (event, surfaces: unknown) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
    expires = Date.now() + 3500
    await layout(surfaces)
  })
}
