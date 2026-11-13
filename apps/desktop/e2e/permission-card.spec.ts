import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MARK = 'PERMISSION-CARD'
const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const TURNS: Array<[role: 'user' | 'assistant', text: string]> = []
for (let index = 0; index < 12; index++) TURNS.push(['user', `Read the KakaoTalk window and tell me what message ${index + 1} says.`], ['assistant', `Message ${index + 1} is a short note about lunch plans and a meeting time later this week.`])
type Box = { left: number; top: number; right: number; bottom: number }
type Window = Record<string, unknown>

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page; lane: string; cleanup: () => Promise<void> }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, `permission-card-${name}-`))
  const userData = await mkdtemp(join(TMP, `permission-card-${name}-user-`))
  const paths = await initVault(vault, { git: false })
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_TEST_PERMISSIONS: '1' },
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  const bot = await createBot(paths, { name: 'Desk' })
  const start = Date.now() - 3_600_000
  for (const [index, [role, text]] of TURNS.entries()) await appendBotTurn(paths, bot.id, { role, text, at: new Date(start + index * 60_000).toISOString() })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1360, 860))
  await openActivity(page, 'bots')
  await page.getByTestId(`bot-${bot.id}`).click()
  await expect(page.locator('.bots-thread')).toContainText(TURNS.at(-1)![1])
  // The real helper is never used: main reads this fake state, and System Settings never opens.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { __opened: opened, __engramPermissionState: { accessibility: true, screenRecording: false, inputMonitoring: true } })
    Object.defineProperty(shell, 'openExternal', { configurable: true, writable: true, value: async (url: string) => { opened.push(url) } })
  })
  expect(await app.evaluate(({ shell }) => String(shell.openExternal).includes('opened'))).toBe(true)
  const cleanup = async () => { await closeTestApp(app); await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }) }
  return { app, page, lane: `bot-${bot.id}`, cleanup }
}

// Starts main's real wait for Screen Recording, as a denied look_desktop step does.
async function startStep(app: ElectronApplication, lane: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, lane) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    for (const event of [{ type: 'comet:working', channel: lane, working: true }, { type: 'comet:step', channel: lane, line: 'look_desktop: KakaoTalk' }]) window.webContents.send('engram:event', event)
    const self = globalThis as Window
    self.__waited = undefined
    void (self.__engramPermissionWait as (lane: string, name: string, task: string) => Promise<string>)(lane, 'screenRecording', 'Read the KakaoTalk window')
      .then(result => {
        self.__waited = result
        if (result === 'on') window.webContents.send('engram:event', { type: 'comet:step', channel: lane, line: 'read_desktop: KakaoTalk' })
      })
  }, lane)
}

test('a missing permission shows one card with a settings button', async () => {
  const { app, page, lane, cleanup } = await launch('show')
  try {
    const thread = page.locator('.bots-thread')
    await thread.evaluate(node => { node.scrollTop = 0 })
    const before = await thread.evaluate(node => node.scrollTop)
    await startStep(app, lane)
    const card = page.getByTestId('permission-card')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('Screen Recording is off')
    await expect(card).toContainText('Needed to see what an app window shows')
    expect(await thread.evaluate(node => node.scrollTop), `${MARK}: the card pulled the thread`).toBe(before)

    await thread.evaluate(node => { node.scrollTop = node.scrollHeight })
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined)))
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    })
    const overlaps = await page.evaluate(() => {
      const rect = (node: Element): Box => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
      const card = rect(document.querySelector('[data-testid="permission-card"]')!)
      return [...document.querySelectorAll('.bots-thread .bubble-msg')].map(rect)
        .filter(box => Math.min(box.right, card.right) - Math.max(box.left, card.left) > 0 && Math.min(box.bottom, card.bottom) - Math.max(box.top, card.top) > 0)
    })
    expect(overlaps, `${MARK}: the card covers a chat bubble`).toEqual([])

    await page.getByTestId('permission-card-open').click()
    await expect.poll(() => app.evaluate(() => (globalThis as Window).__opened)).toEqual([PANE])

    await openActivity(page, 'notes').catch(() => openActivity(page, 'mission'))
    await openActivity(page, 'bots')
    await expect(page.getByTestId('permission-card')).toHaveCount(1)
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
    await test.info().attach(MARK, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
  } finally { await cleanup() }
})

test('the card leaves when the permission turns on', async () => {
  const { app, page, lane, cleanup } = await launch('leave')
  try {
    await startStep(app, lane)
    await expect(page.getByTestId('permission-card')).toHaveCount(1)
    await page.waitForTimeout(2500)
    await expect(page.getByTestId('permission-card'), `${MARK}: the card left while the permission was still off`).toHaveCount(1)
    expect(await app.evaluate(() => (globalThis as Window).__waited)).toBeUndefined()

    await app.evaluate(() => { (globalThis as Window).__engramPermissionState = { accessibility: true, screenRecording: true, inputMonitoring: true } })
    await expect(page.getByTestId('permission-card')).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => app.evaluate(() => (globalThis as Window).__waited)).toBe('on')
    await expect(page.getByTestId('bots-thinking')).toHaveAttribute('aria-label', 'read_desktop: KakaoTalk')
    await expect(page.locator('.bots-thread')).toContainText(TURNS.at(-1)![1])
    expect(await app.evaluate(() => (globalThis as Window).__opened)).toEqual([])
  } finally { await cleanup() }
})
