import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

test('background browser windows preserve native conversation focus and the draft', async () => {
  test.skip(process.platform !== 'darwin', 'Exercises the macOS background browser')
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const run = await mkdtemp(join(tmp, 'browser-focus-'))
  const paths = await initVault(join(run, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Background work' })
  const second = await createBot(paths, { name: 'Second conversation' })
  let popups = 0
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    if (request.url === '/popup') { popups++; response.end('<html><h1>Background popup is ready</h1><script>window.focus()</script></html>'); return }
    response.end('<html><title>Background browser check</title><button style="position:fixed;inset:0 0 70%;width:100%" onclick="window.open(\'/popup\',\'task\',\'width=600,height=500\')?.focus()">Open background popup</button><p>The conversation keeps keyboard focus.</p></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const url = `http://127.0.0.1:${address.port}/`
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url))], env: {
      ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: join(run, 'profile'),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '1',
    } })
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await app.evaluate(({ app, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setBounds({ x: 30, y: 60, width: 1250, height: 900 })
      win.show(); app.focus({ steal: true }); win.focus()
    })
    await openActivity(page, 'bots')
    await page.locator('.bots-row', { hasText: 'Background work' }).click()
    const draft = 'My conversation stays in front while the browser works.'
    await page.getByTestId('bots-input').fill(draft)
    await app.evaluate(({ BrowserWindow }) => {
      const state = globalThis as unknown as { focusLosses: number }
      state.focusLosses = 0
      BrowserWindow.getAllWindows()[0]!.on('blur', () => state.focusLosses++)
    })
    const focused = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('work-preview'))?.isFocused())
    expect(await focused()).toBe(true)
    for (const id of [bot.id, second.id]) {
      await page.evaluate(async ({ lane, url }) => window.engram.agentGo(url, lane), { lane: `bot-${id}`, url })
      expect(await focused()).toBe(true)
    }
    await expect(page.locator('.browser-preview canvas[data-painted]')).toBeVisible()
    await page.evaluate(async lane => {
      for (const type of ['pressed', 'released'] as const) await window.engram.agentInput({ kind: 'mouse', type, x: 0.5, y: 0.1, button: 'left', clicks: 1 }, lane)
    }, `bot-${bot.id}`)
    await expect.poll(() => popups).toBeGreaterThan(0)
    expect(await focused()).toBe(true)
    await expect(page.getByTestId('bots-input')).toHaveValue(draft)
    const focusLosses = await app.evaluate(() => (globalThis as unknown as { focusLosses: number }).focusLosses)
    expect(focusLosses).toBe(0)
    await page.screenshot({ path: join(run, 'conversation.png') })
    if (process.env['ENGRAM_CAPTURE_DESKTOP'] === '1') execFileSync('/usr/sbin/screencapture', ['-x', join(run, 'desktop.png')])
    await writeFile(join(run, 'result.json'), JSON.stringify({ passed: true, nativeFocusLosses: focusLosses, draftPreserved: true, popupLoaded: true }))
    console.log('Native focus evidence:', run)
  } finally {
    try { await closeTestApp(app) } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})
