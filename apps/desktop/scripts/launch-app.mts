// Start the built app and take hold of its window.
//
// Playwright's own Electron launcher attaches through the Node inspector, and
// a machine whose endpoint protection refuses that attach leaves the process
// alive with no window and no error — the app never runs a line. Starting the
// binary the way a person does and connecting over the DevTools port keeps the
// probes working there.
import { chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RunningApp {
  page: Page
  close: () => Promise<void>
}

const ELECTRON = fileURLToPath(
  new URL('../node_modules/electron/dist/electron.exe', import.meta.url),
)
const MAIN = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

async function portFrom(userData: string, deadline: number): Promise<number> {
  for (;;) {
    try {
      const text = await readFile(join(userData, 'DevToolsActivePort'), 'utf8')
      const port = Number(text.split('\n')[0])
      if (port > 0) return port
    } catch {
      /* the app has not written it yet */
    }
    if (Date.now() > deadline) throw new Error('the app never opened a debugging port')
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function launchApp(env: Record<string, string>): Promise<RunningApp> {
  try {
    return await start(env, 45_000)
  } catch {
    // A compositor that cannot draw a custom title bar hangs the window
    // constructor outright; the app itself falls back after one such
    // launch, and a probe cannot afford to wait for the next one.
    console.log('golden: no window with the app drawing its own title bar — retrying with the system frame')
    return await start({ ...env, ENGRAM_SYSTEM_FRAME: '1' }, 90_000)
  }
}

async function start(env: Record<string, string>, budgetMs: number): Promise<RunningApp> {
  const userData = env['ENGRAM_USERDATA']
  if (!userData) throw new Error('launchApp needs ENGRAM_USERDATA')
  const child: ChildProcess = spawn(
    ELECTRON,
    [MAIN, '--no-sandbox', '--remote-debugging-port=0', '--remote-allow-origins=*'],
    { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: false },
  )
  const deadline = Date.now() + budgetMs
  const port = await portFrom(userData, deadline)
  let browser: Browser | undefined
  let page: Page | undefined
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const context = browser.contexts()[0]
      page = context?.pages()[0] ?? (await context?.waitForEvent('page', { timeout: 30_000 }))
      if (page) break
    } catch {
      /* the window is still on its way */
    }
    if (Date.now() > deadline) {
      await browser?.close().catch(() => {})
      child.kill()
      throw new Error('the app opened no window')
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return {
    page,
    close: async () => {
      await browser?.close().catch(() => {})
      child.kill()
    },
  }
}
