import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, initVault } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, dirs: string[] = [], paths: Awaited<ReturnType<typeof initVault>>

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-fade-vault-')), data = await mkdtemp(join(tmp, 'e2e-fade-data-'))
  dirs = [vault, data]
  paths = await initVault(vault, { git: false })
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

test('qa143 S24: with no title pill, scrolled messages are cut off at the thread top and nothing sits over them', async () => {
  const thread = page.locator('[data-testid="bots-view"] .bots-thread')
  const edges = await thread.evaluate(node => {
    node.scrollTop = 120
    const box = node.getBoundingClientRect()
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + 4)
    return { scrolled: node.scrollTop, threadTop: box.top, pills: document.querySelectorAll('[data-testid="bots-title-pill"]').length, own: !!at && node.contains(at) }
  })
  expect(edges.scrolled).toBeGreaterThan(0)
  expect(edges.pills).toBe(0)
  expect(edges.own).toBe(true)
  await thread.evaluate(node => { node.scrollTop = 0 })
  const first = await thread.locator('.bubble-msg').first().boundingBox()
  expect(first!.y).toBeGreaterThanOrEqual(edges.threadTop)
})

test('qa143 S04/S14: one answer is one bubble, and a file made in a turn is carded once', async () => {
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Card Bot' }))
  const at = new Date().toISOString(), link = '[deck.pptx](engram-artifact:deck.pptx)'
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'Make the deck', at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `Made the deck.\n\n${link}\n\n---\n\nFour slides, cover first.`, at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `Read it again.\n\n${link}`, at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `All checked.\n---\nNothing to fix.\n\n\`\`\`replies\nThanks\nAdd a slide\n\`\`\`\n\n${link}`, at })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${bot.id}`).click()
  const answers = page.locator('[data-testid="bots-view"] .bots-thread .bubble-msg.assistant')
  await expect(answers).toHaveCount(3)
  await expect(answers.nth(0)).toContainText('Made the deck.')
  await expect(answers.nth(0)).toContainText('Four slides, cover first.')
  await expect(answers.nth(0).locator('h2, hr')).toHaveCount(0)
  await expect(answers.nth(2)).toContainText('Nothing to fix.')
  await expect(page.locator('[data-testid="bots-view"] [data-testid="answer-file"]')).toHaveCount(1)
  await expect(answers.nth(2).getByTestId('answer-file')).toHaveCount(1)
})

test('qa143 S32: an answer its re-check says again is one bubble, and a distinct reply stays', async () => {
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Recheck Bot' }))
  const at = new Date().toISOString()
  const answer = 'Here are the draft numbers next to ours.\n\n| Item | Draft |\n| --- | --- |\n| Price | 12,000 |\n| Units | 300 |\n\nFill in the empty cells and I will redo the totals.'
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'Use our numbers', at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'Reading the sheet first.', progress: true, at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: answer, progress: true, at })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `I checked the draft values and found no mismatch.\n\n${answer}`, at })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${bot.id}`).click()
  const answers = page.locator('[data-testid="bots-view"] .bots-thread .bubble-msg.assistant')
  await expect(answers).toHaveCount(2)
  await expect(answers.nth(0)).toHaveText('Reading the sheet first.')
  await expect(answers.nth(1)).toContainText('found no mismatch')
  await expect(page.locator('[data-testid="bots-view"] .bots-thread').getByText('Fill in the empty cells')).toHaveCount(1)
})
