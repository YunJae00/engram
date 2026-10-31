import { app, BrowserWindow, screen, nativeImage } from 'electron'
import { join } from 'node:path'
import { desktopBinding, keptOut, type DesktopBinding } from './desktop-access.js'
import type { DesktopObservationDto, WorkPreviewDto } from '../shared/desktop.js'
import { desktopImage } from './desktop-image.js'
import type { Page } from 'playwright-core'
import { maskedFrame } from './masked-frame.js'
import { allowNavigation } from './security.js'

const entries = new Map<string, WorkPreviewDto>()
const browserSources = new Map<string, { page: Page; url: string }>()
const valid = new Map<string, () => boolean>()
const refresh = new Map<string, ReturnType<typeof setTimeout>>()
const pending = new Set<string>()
const lastCapture = new Map<string, number>()
let window: BrowserWindow | undefined
let timer: ReturnType<typeof setInterval> | undefined
let quitting = false
let hooked = false
const MAX_AGE = 15_000

function publish(): void {
  for (const [id, entry] of entries) if (Date.now() - entry.at > MAX_AGE || !valid.get(id)?.()) {
    entries.delete(id); lastCapture.delete(id); valid.delete(id); browserSources.delete(id)
  }
  if (!entries.size) { window?.hide(); window?.destroy(); window = undefined; clearInterval(timer); timer = undefined; return }
  if (!window || window.isDestroyed()) {
    if (!hooked) { hooked = true; app.once('before-quit', closeWorkPreview) }
    const work = screen.getPrimaryDisplay().workArea
    window = new BrowserWindow({
      x: work.x + work.width - 284, y: work.y + 16, width: 268, height: Math.min(720, work.height - 32),
      frame: false, transparent: true, focusable: false, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, resizable: false, show: false,
      webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
    })
    const view = window
    view.setIgnoreMouseEvents(true)
    view.setContentProtection(true)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (e: { preventDefault(): void }, url: string) => { if (!allowNavigation(url, process.env['ELECTRON_RENDERER_URL'])) e.preventDefault() }
    view.webContents.on('will-navigate', guard)
    view.webContents.on('will-redirect', guard)
    // React subscribes after did-finish-load; renew the frame on the timer too.
    view.webContents.on('did-finish-load', () => { if (entries.size && !quitting) view.showInactive() })
    const dev = process.env['ELECTRON_RENDERER_URL']
    void (dev ? view.loadURL(`${dev}#work-preview`) : view.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'work-preview' })).catch(() => view.destroy())
  }
  window.webContents.send('engram:event', { type: 'desktop:preview', frames: [...entries.values()].reverse() })
  if (!window.webContents.isLoading()) window.showInactive()
  if (!timer) timer = setInterval(publish, 1000).unref()
}

export function closeWorkPreview(): void {
  quitting = true
  entries.clear(); lastCapture.clear(); valid.clear(); browserSources.clear()
  for (const handle of refresh.values()) clearTimeout(handle)
  refresh.clear()
  clearInterval(timer); timer = undefined
  window?.destroy(); window = undefined
}

export function showWorkPreview(binding: DesktopBinding): void {
  if (quitting || binding.host.closed || binding.stopped || !binding.readable) return
  const key = `${binding.lane}:${binding.source}`
  valid.set(key, () => { const current = desktopBinding(binding.lane); return Boolean(current?.host === binding.host && current.readable && !current.stopped && !current.host.closed && binding.readable && !binding.stopped && !keptOut(binding.name)) })
  const prior = entries.get(key)
  entries.delete(key)
  entries.set(key, { id: key, title: binding.name, at: Date.now(), ...(prior?.data ? { data: prior.data } : {}) })
  while (entries.size > 4) { const oldest = entries.keys().next().value!; entries.delete(oldest); lastCapture.delete(oldest); valid.delete(oldest); browserSources.delete(oldest) }
  publish()
  if (pending.has(key) || Date.now() - (lastCapture.get(key) ?? 0) < 2000 || pending.size >= 2) {
    if (!refresh.has(key)) refresh.set(key, setTimeout(() => { refresh.delete(key); if (valid.get(key)?.() && desktopBinding(binding.lane) === binding) showWorkPreview(binding) }, 2100).unref())
    return
  }
  pending.add(key)
  lastCapture.set(key, Date.now())
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  const observe = () => binding.host.request<DesktopObservationDto>('observe', { window: binding.window, pid: binding.pid }, controller.signal)
  void desktopImage(binding, observe, controller.signal).then(result => {
    const entry = entries.get(key)
    if (entry && !quitting && !binding.host.closed && !binding.stopped && binding.readable && result.image) entry.data = nativeImage.createFromBuffer(Buffer.from(result.image.data, 'base64')).resize({ width: 500 }).toDataURL()
  }).catch(() => { const entry = entries.get(key); if (entry) delete entry.data }).finally(() => {
    clearTimeout(timeout); pending.delete(key)
    if (!quitting && entries.has(key)) publish()
  })
}


export function showBrowserWorkPreview(lane: string, page: Page): void {
  if (!app?.isReady?.() || quitting || page.isClosed() || !/^https?:/.test(page.url())) return
  const key = `${lane}:browser`
  const url = page.url()
  const same = browserSources.get(key)?.page === page && browserSources.get(key)?.url === url
  browserSources.set(key, { page, url })
  valid.set(key, () => !page.isClosed())
  const prior = same ? entries.get(key) : undefined
  entries.delete(key)
  entries.set(key, { id: key, title: new URL(page.url()).hostname, at: Date.now(), ...(prior?.data ? { data: prior.data } : {}) })
  while (entries.size > 4) { const oldest = entries.keys().next().value!; entries.delete(oldest); valid.delete(oldest); lastCapture.delete(oldest); browserSources.delete(oldest) }
  publish()
  if (pending.has(key) || Date.now() - (lastCapture.get(key) ?? 0) < 2000 || pending.size >= 2) {
    if (!refresh.has(key)) refresh.set(key, setTimeout(() => { refresh.delete(key); if (browserSources.get(key)?.page === page && !page.isClosed()) showBrowserWorkPreview(lane, page) }, 2100).unref())
    return
  }
  pending.add(key); lastCapture.set(key, Date.now())
  void maskedFrame(page, new URL(page.url()).origin, []).then(data => {
    const entry = entries.get(key)
    if (entry && !quitting && !page.isClosed() && page.url() === url && browserSources.get(key)?.page === page && browserSources.get(key)?.url === url) entry.data = nativeImage.createFromBuffer(data).resize({ width: 500 }).toDataURL()
  }).catch(() => { const entry = entries.get(key); if (entry) delete entry.data }).finally(() => {
    pending.delete(key)
    if (!quitting && entries.has(key)) publish()
  })
}
