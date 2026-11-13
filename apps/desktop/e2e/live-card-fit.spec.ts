import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const LONG = 'This answer runs long on purpose so the bubble spans the whole reading lane. It lists what the bot checked, what it found in the open window, which parts still need a decision, and what it plans to do next once the person confirms the step. '
type Box = { left: number; top: number; right: number; bottom: number }
type Frame = { id: string; width: number; height: number }
type View = 'single' | 'split-2' | 'split-4'

const frame = (width: number, height: number): Frame => ({ id: `w${width}x${height}`, width, height })

async function launch(name: string) {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, `${name}-`))
  const userData = await mkdtemp(join(TMP, `${name}-user-`))
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths)
  const bots = []
  for (const letter of ['A', 'B', 'C', 'D']) {
    const bot = await createBot(paths, { name: `Fit ${letter}` })
    const start = Date.now() - 3_600_000
    for (let turn = 0; turn < 30; turn++) {
      const text = turn % 2 ? `${turn}. ${LONG}${LONG.slice(0, 160)}` : `Short turn ${turn}, please check.`
      await appendBotTurn(paths, bot.id, { role: turn % 2 ? 'assistant' : 'user', text, at: new Date(start + turn * 60_000).toISOString() })
    }
    bots.push(bot)
  }
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('native:enabled'); ipcMain.handle('native:enabled', () => false) })
  await page.evaluate(ids => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map(bot => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  const cleanup = async () => { await closeTestApp(app); await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }) }
  return { app, page, ids: bots.map(bot => bot.id), cleanup }
}

async function push(app: ElectronApplication, lanes: Record<string, Frame[]>) {
  const all = []
  for (const [id, list] of Object.entries(lanes)) {
    for (const one of list) {
      const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toDataURL(), one)
      all.push({ id: `bot-${id}:window:${one.id}`, lane: `bot-${id}`, title: one.id, at: Date.now(), captureState: 'ready', current: false, data })
    }
  }
  await app.evaluate(({ BrowserWindow, ipcMain }, frames) => {
    ipcMain.removeHandler('desktop:previews')
    ipcMain.handle('desktop:previews', (_event, lane: string) => frames.filter(one => one.lane === lane))
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    window.webContents.send('engram:event', { type: 'desktop:preview', frames })
  }, all)
}

async function resize(app: ElectronApplication, page: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 500); win.setContentSize(width, 800) }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 800])
  if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
}

async function show(page: Page, view: View, first: string) {
  if (view === 'single') {
    await openActivity(page, 'bots')
    const item = page.getByTestId(`bot-${first}`)
    if (!(await item.getAttribute('class'))?.includes('active')) await item.click()
    await expect(page.locator('.bots-chat')).toBeVisible()
  } else {
    await openActivity(page, 'mission')
    await page.getByTestId(view === 'split-2' ? 'mission-layout-2' : 'mission-layout-4').click()
  }
}

const settle = (page: Page) => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined)))
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
})

const chats = (view: View) => view === 'single' ? '.bots-chat' : '.mini-chat'
const threads = (view: View) => view === 'single' ? '.bots-chat > .bots-thread' : '.mini-chat > .mini-chat-thread'

const inspect = (page: Page, view: View) => page.evaluate(({ chat, thread }) => {
  const rect = (node: Element): Box => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
  return [...document.querySelectorAll(chat)].map(pane => {
    const cards = [...pane.querySelectorAll('.preview-card, .preview-deck-card')]
      .filter(node => { const box = node.getBoundingClientRect(); return getComputedStyle(node).visibility !== 'hidden' && box.width > 0 && box.height > 0 }).map(rect)
    const lane = pane.querySelector(thread)
    const bubbles = [...pane.querySelectorAll('.bubble-msg')].filter(node => node.getBoundingClientRect().width > 0)
      .map(node => ({ text: (node.textContent ?? '').trim().slice(0, 30), box: rect(node) }))
    return { cards, bubbles, lane: lane ? rect(lane) : undefined }
  })
}, { chat: chats(view), thread: threads(view) })

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1

test('a live card never covers chat bubbles', async () => {
  const { app, page, ids, cleanup } = await launch('live-card-fit-cover')
  try {
    await resize(app, page, 1280)
    await push(app, { [ids[0]!]: [frame(1280, 800)], [ids[1]!]: [frame(1280, 800)] })
    for (const view of ['single', 'split-2', 'split-4'] as View[]) {
      await show(page, view, ids[0]!)
      await expect(page.locator(chats(view)).getByTestId('preview-card').first()).toBeVisible()
      for (const at of ['top', 'middle', 'bottom']) {
        await page.evaluate(({ selector, at }) => {
          for (const node of document.querySelectorAll(selector)) {
            const end = node.scrollHeight - node.clientHeight
            node.scrollTop = at === 'top' ? 0 : at === 'middle' ? end / 2 : node.scrollHeight
          }
        }, { selector: threads(view), at })
        await settle(page)
        const panes = await inspect(page, view)
        expect(panes.some(pane => pane.cards.length > 0), `${view} ${at}: a live card is showing`).toBe(true)
        expect(panes.every(pane => pane.bubbles.length > 0), `${view} ${at}: bubbles are in view`).toBe(true)
        // Split panes on base reserve a band above the thread, so only the single view proves a bubble reaches the card's band at rest.
        if (at === 'top' && view === 'single') {
          for (const pane of panes.filter(one => one.cards.length)) {
            const band = { top: Math.min(...pane.cards.map(one => one.top)), bottom: Math.max(...pane.cards.map(one => one.bottom)) }
            expect(pane.bubbles.some(one => one.box.bottom > band.top && one.box.top < band.bottom), `${view} top: a bubble sits in the card's band`).toBe(true)
          }
        }
        const violations = async () => (await inspect(page, view)).flatMap(pane => pane.bubbles.flatMap(bubble => pane.cards.filter(card => overlaps(bubble.box, card))
          .map(card => `LIVE-CARD-OVERLAP ${view} ${at}: "${bubble.text}" ${JSON.stringify(bubble.box)} vs card ${JSON.stringify(card)}`)))
        await expect.poll(violations, { message: `LIVE-CARD-OVERLAP ${view} ${at}`, timeout: 5000 }).toEqual([])
      }
    }
  } finally { await cleanup() }
})

test('each live card has its window aspect with no letterbox', async () => {
  const { app, page, ids, cleanup } = await launch('live-card-fit-aspect')
  try {
    const sizes = { [ids[0]!]: [frame(600, 800), frame(800, 600), frame(420, 760), frame(1280, 800)], [ids[1]!]: [frame(800, 600), frame(420, 760)] }
    await resize(app, page, 1280)
    await push(app, sizes)
    for (const width of [1280, 720]) {
      await resize(app, page, width)
      for (const view of ['single', 'split-2'] as View[]) {
        await show(page, view, ids[0]!)
        const lanes = view === 'single' ? [ids[0]!] : [ids[0]!, ids[1]!]
        for (const id of lanes) {
          const deck = page.locator(`${chats(view)} [data-testid=preview-deck]:has(.preview-card[data-lane="bot-${id}"])`)
          await expect(deck).toBeVisible()
          for (const one of [...sizes[id]!].reverse()) {
            const back = deck.locator(`.preview-deck-back[aria-label="${one.id}"]`)
            if (await back.count()) await back.evaluate(node => (node as HTMLElement).click())
            await expect(deck.locator('[data-position="0"]')).toHaveAttribute('data-frame', `bot-${id}:window:${one.id}`)
            const card = deck.locator('[data-position="0"] .preview-card')
            await expect.poll(() => card.locator('img').evaluate(node => [(node as HTMLImageElement).naturalWidth, (node as HTMLImageElement).naturalHeight])).toEqual([one.width, one.height])
            const measure = () => card.evaluate(node => {
              const rect = (element: Element) => element.getBoundingClientRect().toJSON() as DOMRect
              const chat = node.closest('.bots-chat, .mini-chat')!.getBoundingClientRect().height
              return { card: rect(node), stage: rect(node.querySelector('.preview-card-stage')!), img: rect(node.querySelector('img')!), chat }
            })
            const label = `LIVE-CARD-ASPECT ${view} ${width} ${one.id}`
            const problems = async () => {
              const { card, stage, img, chat } = await measure()
              const off = (a: DOMRect, b: DOMRect) => Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom)) > 2
              const ratio = stage.width / stage.height / (one.width / one.height)
              return [
                Math.abs(ratio - 1) > 0.02 ? `${label}: stage ${Math.round(stage.width)}x${Math.round(stage.height)} is not ${one.width}:${one.height}` : '',
                off(img, stage) ? `${label}: picture ${Math.round(img.width)}x${Math.round(img.height)} is not the stage` : '',
                off(card, stage) ? `${label}: card ${Math.round(card.width)}x${Math.round(card.height)} has blank area around the stage` : '',
                stage.height > chat / 2 + 1 ? `${label}: stage ${Math.round(stage.height)} is taller than half the chat ${Math.round(chat)}` : '',
              ].filter(Boolean)
            }
            await expect.poll(problems, { message: label, timeout: 5000 }).toEqual([])
          }
        }
        if (view === 'split-2') {
          await settle(page)
          const shapes = await Promise.all(lanes.map((id, index) => page.locator(`.mini-chat [data-testid=preview-deck]:has(.preview-card[data-lane="bot-${id}"])`).locator('[data-position="0"] .preview-card-stage').evaluate((node, index) => ({ index, ratio: node.getBoundingClientRect().width / node.getBoundingClientRect().height }), index)))
          expect(Math.abs(shapes[0]!.ratio / shapes[1]!.ratio - 1), `LIVE-CARD-ASPECT split-2 ${width}: two windows of different shapes give different cards`).toBeGreaterThan(0.1)
        }
      }
    }
  } finally { await cleanup() }
})
