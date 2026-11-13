import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type Bot } from 'core'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const LONG = 'The agent opened the report, compared the quarterly numbers with last year, and wrote down where the totals drift. It then checked each source link, noted which pages were behind a login, and listed what still needs a person to confirm before anything is sent. '
type Box = { left: number; top: number; right: number; bottom: number }
type View = 'single' | 'two' | 'four'
type Frame = { id: string; lane: string; title: string; at: number; captureState: 'ready'; current: false; data: string }

async function launch(name: string) {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, `live-card-fit-${name}-`))
  const userData = await mkdtemp(join(TMP, `live-card-fit-${name}-user-`))
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths)
  const bots: Bot[] = []
  for (const bot of ['Alpha', 'Bravo', 'Charlie', 'Delta']) bots.push(await createBot(paths, { name: bot, purpose: '' }))
  const start = Date.now() - 3_600_000
  for (const bot of bots) {
    for (let index = 0; index < 30; index++) {
      const role = index % 2 ? 'assistant' : 'user'
      const text = index % 4 < 2 ? `${index + 1}. ${LONG}${LONG}` : `${index + 1}. Short ${role} line.`
      await appendBotTurn(paths, bot.id, { role, text, at: new Date(start + index * 60_000).toISOString() })
    }
  }
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await page.evaluate(ids => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map(bot => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  const close = async () => {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
  return { app, page, bots, close }
}

async function resize(app: ElectronApplication, page: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 600); win.setContentSize(width, 800) }, width)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 800])
}

async function frame(app: ElectronApplication, lane: string, width: number, height: number): Promise<Frame> {
  const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toDataURL(), { width, height })
  return { id: `${lane}:window:w${width}x${height}`, lane, title: `w${width}x${height}`, at: Date.now(), captureState: 'ready', current: false, data }
}

async function push(app: ElectronApplication, frames: Frame[]) {
  await app.evaluate(({ BrowserWindow, ipcMain }, frames) => {
    ipcMain.removeHandler('desktop:previews')
    ipcMain.handle('desktop:previews', (_event, lane: string) => frames.filter(frame => frame.lane === lane))
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'desktop:preview', frames })
  }, frames)
}

async function show(page: Page, view: View, bot: Bot) {
  if (view === 'single') {
    await openActivity(page, 'bots')
    await page.getByTestId('mission-layout-1').click()
    // A narrow window folds the sidebar away, so the row is clicked without a pointer.
    await page.getByTestId(`bot-${bot.id}`).dispatchEvent('click')
    await expect(page.locator('.bots-thread')).toBeVisible()
    return
  }
  await openActivity(page, 'mission')
  await page.getByTestId(view === 'two' ? 'mission-layout-2' : 'mission-layout-4').click()
  await expect(page.locator('.mini-chat-thread')).toHaveCount(view === 'two' ? 2 : 4)
}

const settle = (page: Page) => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined)))
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
})

const scene = (page: Page) => page.evaluate(() => {
  const rect = (node: Element): Box => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, right: one.right, bottom: one.bottom } }
  const visible = (node: Element) => { const box = node.getBoundingClientRect(); return getComputedStyle(node).visibility !== 'hidden' && box.width > 0 && box.height > 0 }
  return [...document.querySelectorAll('.bots-chat, .mini-chat')].filter(visible).map(chat => ({
    cards: [...chat.querySelectorAll('.preview-card, .preview-deck-card')].filter(visible).map(rect),
    bubbles: [...chat.querySelectorAll('.bubble-msg')].filter(visible).map(node => ({ text: (node.textContent ?? '').trim().slice(0, 30), box: rect(node) })),
  }))
})

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1

test('a live card never covers chat bubbles', async () => {
  test.setTimeout(240_000)
  const { app, page, bots, close } = await launch('overlap')
  try {
    await resize(app, page, 1280)
    await push(app, [await frame(app, `bot-${bots[0]!.id}`, 1280, 800), await frame(app, `bot-${bots[1]!.id}`, 1280, 800)])
    for (const view of ['single', 'two', 'four'] as const) {
      await show(page, view, bots[0]!)
      await expect(page.locator('.preview-card:visible').first()).toBeVisible({ timeout: 20_000 })
      for (const at of ['top', 'middle', 'bottom'] as const) {
        await page.locator('.bots-thread, .mini-chat-thread').evaluateAll((nodes, at) => {
          for (const node of nodes) node.scrollTop = at === 'top' ? 0 : at === 'middle' ? (node.scrollHeight - node.clientHeight) / 2 : node.scrollHeight
        }, at)
        await settle(page)
        const panes = await scene(page)
        expect(panes.some(pane => pane.cards.length > 0), `${view} ${at}: a live card is showing`).toBe(true)
        expect(panes.some(pane => pane.bubbles.length > 0), `${view} ${at}: bubbles are in view`).toBe(true)
        if (at === 'top') {
          for (const pane of panes.filter(one => one.cards.length)) {
            const top = Math.min(...pane.cards.map(one => one.top)), bottom = Math.max(...pane.cards.map(one => one.bottom))
            expect(pane.bubbles.some(one => one.box.bottom > top && one.box.top < bottom), `${view} top: a bubble sits in the card's band`).toBe(true)
          }
        }
        const violations = async () => (await scene(page)).flatMap(pane => pane.bubbles.flatMap(bubble => pane.cards.filter(card => overlaps(bubble.box, card))
          .map(card => `LIVE-CARD-OVERLAP ${view} ${at}: "${bubble.text}" ${JSON.stringify(bubble.box)} vs card ${JSON.stringify(card)}`)))
        await expect.poll(violations, { message: `LIVE-CARD-OVERLAP ${view} ${at}`, timeout: 5_000 }).toEqual([])
      }
    }
  } finally {
    await close()
  }
})

test('each live card has its window aspect with no letterbox', async () => {
  test.setTimeout(300_000)
  const { app, page, bots, close } = await launch('aspect')
  try {
    const [a, b] = bots.map(bot => `bot-${bot.id}`) as [string, string]
    const sizes: Record<string, Array<[number, number]>> = { [a]: [[600, 800], [800, 600], [420, 760], [1280, 800]], [b]: [[800, 600], [420, 760]] }
    const frames: Frame[] = []
    for (const [lane, list] of Object.entries(sizes)) for (const [width, height] of list) frames.push(await frame(app, lane, width, height))
    await push(app, frames)
    const measure = (lane: string) => page.evaluate(lane => {
      const card = [...document.querySelectorAll(`.preview-card[data-lane="${lane}"]`)].find(node => node.getBoundingClientRect().width > 0)
      const stage = card?.querySelector('.preview-card-stage'), img = stage?.querySelector('img')
      if (!card || !stage || !img) return undefined
      const rect = (node: Element) => { const one = node.getBoundingClientRect(); return { left: one.left, top: one.top, width: one.width, height: one.height } }
      return { natural: [img.naturalWidth, img.naturalHeight], card: rect(card), stage: rect(stage), img: rect(img), chat: card.closest('.bots-chat, .mini-chat')!.getBoundingClientRect().height }
    }, lane)
    const near = (x: { left: number; top: number; width: number; height: number }, y: typeof x) => Math.max(Math.abs(x.left - y.left), Math.abs(x.top - y.top), Math.abs(x.width - y.width), Math.abs(x.height - y.height)) <= 2
    for (const width of [1280, 720]) {
      await resize(app, page, width)
      for (const view of ['single', 'two'] as const) {
        await show(page, view, bots[0]!)
        const lanes = view === 'single' ? [a] : [a, b]
        for (const lane of lanes) {
          for (const [w, h] of sizes[lane]!) {
            const id = `${lane}:window:w${w}x${h}`
            const deck = page.locator(`.preview-deck:visible:has(.preview-card[data-lane="${lane}"])`)
            await expect(deck).toBeVisible({ timeout: 20_000 })
            if (await deck.locator('.preview-deck-card[data-position="0"]').getAttribute('data-frame') !== id) await deck.locator(`.preview-deck-card[data-frame="${id}"] .preview-deck-back`).dispatchEvent('click')
            await expect(deck.locator('.preview-deck-card[data-position="0"]')).toHaveAttribute('data-frame', id)
            await expect.poll(async () => (await measure(lane))?.natural, { timeout: 10_000 }).toEqual([w, h])
            await settle(page)
            const marker = `LIVE-CARD-ASPECT ${view} ${width} w${w}x${h}`
            const problems = async () => {
              const box = await measure(lane)
              if (!box) return [`${marker}: card missing`]
              const issues: string[] = []
              const ratio = box.stage.width / box.stage.height / (w / h)
              if (Math.abs(ratio - 1) > 0.02) issues.push(`${marker}: stage ${Math.round(box.stage.width)}x${Math.round(box.stage.height)} is off the frame ratio by ${Math.round((ratio - 1) * 100)}%`)
              if (!near(box.img, box.stage)) issues.push(`${marker}: image box ${JSON.stringify(box.img)} differs from stage ${JSON.stringify(box.stage)}`)
              if (!near(box.card, box.stage)) issues.push(`${marker}: card ${JSON.stringify(box.card)} has blank area around stage ${JSON.stringify(box.stage)}`)
              if (box.stage.height > box.chat / 2 + 1) issues.push(`${marker}: stage ${Math.round(box.stage.height)}px is taller than half the chat ${Math.round(box.chat)}px`)
              return issues
            }
            await expect.poll(problems, { message: marker, timeout: 5_000 }).toEqual([])
          }
        }
        if (view === 'two') {
          for (const [lane, id] of [[a, `${a}:window:w600x800`], [b, `${b}:window:w800x600`]] as const) {
            const deck = page.locator(`.preview-deck:visible:has(.preview-card[data-lane="${lane}"])`)
            await deck.locator(`.preview-deck-card[data-frame="${id}"] .preview-deck-back`).dispatchEvent('click')
            await expect(deck.locator('.preview-deck-card[data-position="0"]')).toHaveAttribute('data-frame', id)
          }
          await expect.poll(async () => {
            const [one, two] = [await measure(a), await measure(b)]
            if (!one || !two) return 0
            return Math.abs((one.stage.width / one.stage.height) / (two.stage.width / two.stage.height) - 1)
          }, { message: `LIVE-CARD-ASPECT two ${width}: cards of different windows share a shape`, timeout: 5_000 }).toBeGreaterThan(0.1)
        }
      }
    }
  } finally {
    await close()
  }
})
