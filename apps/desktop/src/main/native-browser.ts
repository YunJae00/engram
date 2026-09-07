import { app, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { flog } from './flog.js'

let owner: BrowserWindow | null = null
let running: NativeBrowser | null = null
let external = false
const nativeContexts = new WeakSet<BrowserContext>()
const targets = new WeakMap<Page, Promise<string>>()
let inputSink: ((page: Page) => void) | undefined
export function setNativeInputSink(sink: (page: Page) => void): void { inputSink = sink }

export function nativeBrowserEnabled(): boolean {
  return process.platform === 'win32' && !external && process.env['ENGRAM_BROWSER_EXTERNAL'] !== '1'
}

export function chooseNativeBrowser(enabled: boolean): void { external = !enabled }
export function setNativeBrowserOwner(window: BrowserWindow): void { owner = window }
export function isNativePage(page: Page): boolean { return nativeContexts.has(page.context()) }
export function isNativeContext(context: BrowserContext): boolean { return nativeContexts.has(context) }
export function nativeBrowserRunning(): boolean { return running !== null }

export async function nativeOpener(page: Page): Promise<Page | null> {
  const helper = running
  if (!helper) return null
  const target = await nativeTarget(page)
  const deadline = Date.now() + 15000
  while (!helper.parents.has(target) && Date.now() < deadline && !page.isClosed()) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const parent = helper.parents.get(target)
  return parent ? helper.pages.get(parent) ?? null : null
}

export async function nativeTarget(page: Page): Promise<string> {
  let held = targets.get(page)
  if (!held) {
    held = (async () => {
      const session = await page.context().newCDPSession(page)
      try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId as string }
      finally { await session.detach().catch(() => undefined) }
    })()
    targets.set(page, held)
    void held.catch(() => targets.delete(page))
  }
  return held
}

export interface NativeBounds { target: string; x: number; y: number; width: number; height: number }

export async function placeNativePages(views: NativeBounds[]): Promise<void> {
  if (running) await running.request('layout', { views })
}

export async function closeNativeBrowser(): Promise<void> {
  const held = running
  if (!held) return
  await held.close()
  if (running === held) running = null
}

export async function createNativePage(context: BrowserContext): Promise<Page> {
  if (!running || running.context !== context) throw new Error('Embedded browser is not connected')
  const response = await running.request('create')
  const target = response['target']
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (await nativeTarget(page).catch(() => '') === target) return page
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  if (typeof target === 'string') await running.request('close', { target }).catch(() => undefined)
  throw new Error('Embedded page did not connect')
}

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No local browser port')); return }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

export async function openNativeBrowser(): Promise<BrowserContext> {
  if (running?.context) return running.context
  if (!owner || owner.isDestroyed()) throw new Error('Open the main window before starting the embedded browser')
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'browser', 'EngramBrowser.exe')
    : fileURLToPath(new URL('../../native-bin/browser/EngramBrowser.exe', import.meta.url))
  if (!existsSync(executable)) throw new Error('Embedded browser is missing. Reinstall Engram or build the browser host.')
  const requestedPort = Number(process.env['ENGRAM_AGENT_CDP'])
  const port = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535 ? requestedPort : await freePort()
  const handle = owner.getNativeWindowHandle().readBigUInt64LE().toString()
  const helper = new NativeBrowser(spawn(executable, [handle, join(app.getPath('userData'), 'webview2-profile'), String(port)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }))
  running = helper
  try {
    await helper.ready
    // NewWindow replaces a WebView target that initially reports as "other".
    // Attach before that transition so popup pages keep their automation session.
    process.env['PW_CHROMIUM_ATTACH_TO_OTHER'] = '1'
    const { chromium } = await import('playwright-core')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 })
    const context = browser.contexts()[0]
    if (!context) throw new Error('Embedded browser has no context')
    helper.browser = browser
    helper.context = context
    nativeContexts.add(context)
    const watch = (page: Page) => {
      const id = nativeTarget(page)
      void id.then((target) => helper.pages.set(target, page)).catch(() => undefined)
      page.once('close', () => {
        void id.then((target) => {
          helper.pages.delete(target)
          helper.parents.delete(target)
          return helper.request('close', { target })
        }).catch(() => undefined)
      })
    }
    context.on('page', watch)
    context.pages().forEach(watch)
    browser.once('disconnected', () => { void helper.close().finally(() => { if (running === helper) running = null }) })
    return context
  } catch (error) {
    await helper.close()
    if (running === helper) running = null
    throw error
  }
}

class NativeBrowser {
  readonly pages = new Map<string, Page>()
  readonly parents = new Map<string, string | null>()
  browser?: Browser
  context?: BrowserContext
  private serial = 0
  private ending?: Promise<void>
  private exited: Promise<void>
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  readonly ready: Promise<void>

  constructor(private child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()))
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Embedded browser startup timed out')), 45000)
      const fail = (error: Error) => {
        clearTimeout(timeout)
        reject(error)
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
        this.pending.clear()
      }
      child.once('error', fail)
      child.once('exit', () => fail(new Error('Embedded browser exited')))
      // Drain diagnostics without storing page addresses or profile contents.
      child.stderr.resume()
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.length > 32768) return
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
        if (message['type'] === 'ready') { clearTimeout(timeout); resolve() }
        if (message['type'] === 'created') this.parents.set(String(message['target']), typeof message['opener'] === 'string' ? message['opener'] : null)
        if (message['type'] === 'input') {
          const page = this.pages.get(String(message['target']))
          if (page && !page.isClosed()) inputSink?.(page)
        }
        if (message['type'] === 'error') { flog('native-browser', String(message['message'])); fail(new Error(String(message['message']))) }
        const pending = this.pending.get(Number(message['id']))
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(Number(message['id']))
        if (message['error']) pending.reject(new Error(String(message['error'])))
        else pending.resolve(message)
      })
    })
  }

  request(method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.child.exitCode !== null || this.child.stdin.destroyed) return Promise.reject(new Error('Embedded browser is closed'))
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Embedded browser ${method} timed out`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, ...args }) + '\n', (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }

  close(): Promise<void> {
    if (this.ending) return this.ending
    this.ending = (async () => {
      await this.browser?.close().catch(() => undefined)
      this.child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 18000) })])
      clearTimeout(timer)
      if (this.child.exitCode === null) { this.child.kill(); await this.exited }
    })()
    return this.ending
  }
}
