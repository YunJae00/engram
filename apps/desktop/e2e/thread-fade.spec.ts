import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, initVault } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, dirs: string[] = []

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-fade-vault-')), data = await mkdtemp(join(tmp, 'e2e-fade-data-'))
  dirs = [vault, data]
  const paths = await initVault(vault, { git: false })
  await writeFile(join(data, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  await expect(page.getByTestId('shell')).toBeVisible()
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Fade Bot' }))
  const at = new Date().toISOString()
  for (let turn = 0; turn < 6; turn++) {
    await appendBotTurn(paths, bot.id, { role: 'user', text: `Question ${turn}`, at })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: `Answer ${turn}. ${'Long before printing, written texts were copied by hand. '.repeat(2)}`, at })
  }
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${bot.id}`).click()
})
test.afterAll(async () => {
  await closeTestApp(app)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test('an in-view message with empty space above it is fully opaque', async () => {
  const thread = page.locator('[data-testid="bots-view"] .bots-thread')
  const answers = thread.locator('.bubble-msg.assistant')
  await expect(answers).toHaveCount(6)
  await expect(thread.locator('.bubble-msg.checking')).toHaveCount(0)
  await page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined))))
  const spot = await thread.evaluate(node => {
    const bubbles = [...node.querySelectorAll<HTMLElement>('.bubble-msg.assistant')]
    const first = bubbles[1]!
    node.scrollTop += first.getBoundingClientRect().top - node.getBoundingClientRect().top - 1
    const box = node.getBoundingClientRect(), top = first.getBoundingClientRect()
    const last = bubbles.map(one => one.getBoundingClientRect()).filter(one => one.top >= box.top + 20 && one.bottom <= box.bottom - 20).at(-1)!
    const opaque = (el: Element | null): boolean => !el || (getComputedStyle(el).opacity === '1' && opaque(el.parentElement))
    return { above: box.top, inView: top.top >= box.top && top.bottom <= box.bottom, opaque: bubbles.every(opaque), first: { x: top.left + 40, y: box.top + 2 }, last: { x: last.left + 40, y: last.top + 2 }, width: innerWidth }
  })
  expect(spot.inView).toBe(true)
  expect(spot.above).toBeGreaterThan(0)
  expect(spot.opaque).toBe(true)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const [first, last] = await app.evaluate(async ({ BrowserWindow }, { points, width }) => {
    const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(), size = image.getSize(), bitmap = image.toBitmap(), scale = size.width / width
    return points.map(({ x, y }) => { const at = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4; return [bitmap[at + 2]!, bitmap[at + 1]!, bitmap[at]!] })
  }, { points: [spot.first, spot.last], width: spot.width })
  for (let channel = 0; channel < 3; channel++) expect(Math.abs(first![channel]! - last![channel]!), `top bubble ${first} vs last bubble ${last}`).toBeLessThanOrEqual(3)
})
