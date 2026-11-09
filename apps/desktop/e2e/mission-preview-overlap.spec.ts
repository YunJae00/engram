import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { closeTestApp, openActivity } from './navigation.js'
import { appendBotTurn, createBot, initVault, type Bot } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let server: Server
let siteUrl: string
let bots: Bot[]

const ANSWER = [
  '핼리 혜성은 태양 주위를 도는 단주기 혜성입니다.',
  '가장 최근 근일점 통과는 1986년이었고, 다음은 2061년으로 예상됩니다.',
  '혜성의 핵은 얼음과 먼지로 이루어져 있으며 길이는 약 15킬로미터입니다.',
  '태양에 가까워지면 코마와 꼬리가 생겨 맨눈으로도 보입니다.',
  '기록상 최초의 관측은 기원전 240년 중국의 사료로 알려져 있습니다.',
  '궤도 주기 74.7년',
].join('\n\n') + '\n\n```replies\n다음 근일점 알려줘\n관측 기록 더 보기\n```'

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const paths = await initVault(await mkdtemp(join(TMP, 'e2e-mission-overlap-vault-')), { git: false })
  const at = new Date().toISOString()
  bots = []
  for (const name of ['Halley', 'Second pane', 'Third pane', 'Fourth pane']) bots.push(await createBot(paths, { name, purpose: '' }))
  await appendBotTurn(paths, bots[0]!.id, { role: 'user', text: '핼리 혜성 찾아줘', at })
  await appendBotTurn(paths, bots[0]!.id, { role: 'assistant', text: ANSWER, at })
  for (const bot of bots.slice(1)) await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'Ready.', at })
  server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>Page ${req.url}</title></head><body><h1>Halley</h1></body></html>`) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the local site did not start')
  siteUrl = `http://127.0.0.1:${address.port}/`
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const probeAddress = probe.address()
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('no browser test port')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-mission-overlap-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
      ENGRAM_AGENT_CDP: String(probeAddress.port), ENGRAM_BROWSER_EXTERNAL: '1',
    },
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await page.evaluate((ids) => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map((bot) => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => {
  try { await closeTestApp(app) } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function expectAnswerClear(pane: Locator): Promise<void> {
  await pane.locator('.mini-chat-thread').evaluate(async (thread) => {
    thread.scrollTop = thread.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const boxes = await pane.evaluate((node) => {
    const rect = (el: Element) => { const { top, bottom, left, right } = el.getBoundingClientRect(); return { top, bottom, left, right } }
    const paragraphs = [...node.querySelectorAll('.bubble-msg.assistant')].at(-1)!.querySelectorAll('p')
    return {
      thread: rect(node.querySelector('.mini-chat-thread')!),
      card: rect(node.querySelector('[data-testid=preview-deck]')!),
      items: [paragraphs[paragraphs.length - 1]!, node.querySelector('[data-testid=reply-chip-0]')!, node.querySelector('[data-testid=reply-chip-1]')!].map(rect),
      lastText: paragraphs[paragraphs.length - 1]!.textContent,
    }
  })
  expect(boxes.lastText).toBe('궤도 주기 74.7년')
  for (const item of boxes.items) {
    const { card, thread } = boxes
    expect(item.bottom <= card.top || item.top >= card.bottom || item.right <= card.left || item.left >= card.right, JSON.stringify({ item, card })).toBe(true)
    expect(item.top >= thread.top - 0.5 && item.bottom <= thread.bottom + 0.5, JSON.stringify({ item, thread })).toBe(true)
  }
  await expect(pane.getByTestId('reply-chip-0')).toBeVisible()
  await expect(pane.getByTestId('reply-chip-1')).toBeVisible()
}

test('a finished web preview card in a 4-pane tile leaves the answer and its reply chips readable without moving the chat', async () => {
  await openActivity(page, 'mission')
  await page.getByTestId('mission-layout-4').click()
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  const pane = page.getByTestId(`mini-chat-${bots[0]!.id}`)
  await expect(pane.getByTestId('reply-chip-0')).toBeVisible()
  await expect(pane.getByTestId('preview-card')).toHaveCount(0)
  const firstTop = () => pane.locator('.bubble-msg').first().evaluate((node) => node.getBoundingClientRect().top)
  const thread = pane.locator('.mini-chat-thread')
  // Stick-to-bottom settles after the transcript paints, so measure from the pinned position.
  await expect.poll(() => thread.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 1)).toBe(true)
  const before = await firstTop()
  const lane = `bot-${bots[0]!.id}`

  await page.evaluate(({ url, lane }) => window.engram.agentGo(url, lane), { url: siteUrl, lane })
  const card = pane.getByTestId('preview-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toHaveAttribute('data-source', 'web')
  await expect(card.locator('canvas[data-painted]')).toHaveCount(1, { timeout: 20_000 })
  await pane.getByTestId('preview-deck').evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)) })
  expect(Math.abs(await firstTop() - before)).toBeLessThanOrEqual(1)
  await expectAnswerClear(pane)

  const size = { width: 320, height: 200 }
  const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toDataURL(), size)
  await app.evaluate(({ BrowserWindow }, frame) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'desktop:preview', frames: [frame] })
  }, { id: `${lane}:window:1`, lane, title: 'Owned app', at: Date.now(), captureState: 'ready', current: false, data })
  await expect(pane.locator('.preview-deck-card')).toHaveCount(2, { timeout: 20_000 })
  await pane.getByTestId('preview-deck').evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)) })
  await expectAnswerClear(pane)
})
