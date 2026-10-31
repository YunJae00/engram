import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { chromium, BrowserContext } from 'playwright-core'
import { createWindowPage } from './browser-window-page.js'

const scales = new WeakMap<BrowserContext, number>()
export function macBrowserScale(context: BrowserContext): number | undefined { return scales.get(context) }

// macOS clamps off-screen Chrome windows back onto the user's desktop.
export async function launchMacBrowser(profile: string, options: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext> {
  if (!options?.executablePath) throw new Error('A browser executable is required')
  const child = spawn(options.executablePath, [
    `--user-data-dir=${profile}`, '--no-startup-window',
    options.args?.find(arg => arg.startsWith('--remote-debugging-port=')) ?? '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--disable-dev-shm-usage', '--disable-popup-blocking', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(options.args ?? []).filter(arg => !arg.startsWith('--remote-debugging-port=')),
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const lines = createInterface({ input: child.stderr! })
  let diagnostics = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const endpoint = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Background browser did not start within 30 seconds')), 30_000)
    lines.on('line', line => {
      diagnostics = `${diagnostics}\n${line}`.slice(-4000)
      const found = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)$/.exec(line)
      if (found) resolve(found[1]!)
    })
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`Background browser exited before connecting:${diagnostics}`)))
  })
  try {
    const address = await endpoint
    clearTimeout(timer)
    const { chromium: driver } = await import('playwright-core')
    const browser = await driver.connectOverCDP(address, { timeout: 15_000 })
    const context = browser.contexts()[0]
    if (!context) { await browser.close(); throw new Error('Background browser has no persistent context') }
    scales.set(context, options.deviceScaleFactor ?? 1)
    context.once('close', () => child.kill())
    browser.once('disconnected', () => child.kill())
    child.once('exit', () => { void browser.close().catch(() => undefined) })
    const size = options.viewport ?? { width: 1280, height: 860 }
    await createWindowPage(context, size)
    return context
  } catch (error) {
    child.kill()
    throw error
  } finally { clearTimeout(timer); lines.close(); child.stderr?.resume() }
}
