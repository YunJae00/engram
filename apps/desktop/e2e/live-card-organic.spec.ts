import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
type Frame = { id: string; lane: string; title: string; at: number; captureState: 'ready'; current: false; data: string }
type Sample = { height: number; same: boolean; filled: boolean; covers: boolean; capped: boolean; entering: boolean; front: string; cards: number; cardAnimations: number; cardLeaving: number; deckLeaving: boolean; transforms: string[] }

async function frame(app: ElectronApplication, lane: string, id: string, width: number, height: number): Promise<Frame> {
  const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toDataURL(), { width, height })
  return { id: `${lane}:window:${id}`, lane, title: id, at: Date.now(), captureState: 'ready', current: false, data }
}

async function push(app: ElectronApplication, frames: Frame[]) {
  await app.evaluate(({ BrowserWindow, ipcMain }, frames) => {
    ipcMain.removeHandler('desktop:previews')
    ipcMain.handle('desktop:previews', (_event, lane: string) => frames.filter(frame => frame.lane === lane))
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'desktop:preview', frames })
  }, frames)
}

const startSampler = (page: Page) => page.evaluate(() => {
  const tagged = document.querySelector('.preview-card')
  const samples: Sample[] = []
  const box = (node: Element | null) => node?.getBoundingClientRect()
  const sample = () => {
    const card = document.querySelector('.preview-card'), stage = card?.querySelector('.preview-card-stage')
    const img = stage?.querySelector('img'), composer = box(document.querySelector('.bots-composer')), rect = box(card ?? null)
    const chat = box(card?.closest('.bots-chat') ?? null)
    const backs = [...document.querySelectorAll('.preview-deck-card:not([data-position="0"])')]
    samples.push({
      height: rect?.height ?? 0,
      same: card === tagged,
      filled: !stage || !!(img?.complete && img.naturalWidth > 0) || !!stage.querySelector('canvas[data-painted], .preview-card-held'),
      covers: !!rect && !!composer && Math.min(rect.right, composer.right) - Math.max(rect.left, composer.left) > 1 && Math.min(rect.bottom, composer.bottom) - Math.max(rect.top, composer.top) > 1,
      capped: !stage || !chat || box(stage)!.height <= chat.height / 2 + 1,
      entering: !!card?.getAnimations().some(one => (one as CSSAnimation).animationName === 'preview-card-in'),
      front: document.querySelector('.preview-deck-card[data-position="0"]')?.getAttribute('data-frame') ?? '',
      cards: document.querySelectorAll('.preview-deck-card').length,
      cardAnimations: backs.filter(node => node.getAnimations().some(one => (one as CSSAnimation).animationName === 'preview-deck-back-in')).length,
      cardLeaving: document.querySelectorAll('.preview-deck-card[data-leaving]').length,
      deckLeaving: !!document.querySelector('.preview-deck[data-leaving]'),
      transforms: backs.map(node => getComputedStyle(node).transform),
    })
    if ((window as unknown as { sampling?: boolean }).sampling) requestAnimationFrame(sample)
  }
  Object.assign(window, { sampling: true, samples })
  requestAnimationFrame(sample)
})

const stopSampler = async (page: Page): Promise<Sample[]> => {
  await page.waitForTimeout(700)
  return page.evaluate(() => { const state = window as unknown as { sampling: boolean; samples: Sample[] }; state.sampling = false; return state.samples })
}

const stageRatio = (page: Page) => page.evaluate(() => { const one = document.querySelector('.preview-card-stage')?.getBoundingClientRect(); return one ? one.width / one.height : 0 })
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(one => one.effect?.getComputedTiming().iterations !== Infinity).map(one => one.finished.catch(() => undefined))))

function expectClear(samples: Sample[], step: string) {
  expect(samples.length, `${step}: frames were sampled`).toBeGreaterThan(10)
  expect(samples.filter(one => one.covers), `${step}: the card never covers the composer`).toEqual([])
  expect(samples.filter(one => !one.capped), `${step}: the stage stays within half the chat`).toEqual([])
}

test('a live card resizes, swaps and re-flows without a jump, a blank stage or covering the composer', async () => {
  test.setTimeout(180_000)
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'live-card-organic-'))
  const userData = await mkdtemp(join(TMP, 'live-card-organic-user-'))
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths)
  const bot = await createBot(paths, { name: 'Alpha', purpose: '' })
  for (let index = 0; index < 12; index++) await appendBotTurn(paths, bot.id, { role: index % 2 ? 'assistant' : 'user', text: `${index + 1}. A line of the conversation that stays readable.`, at: new Date(Date.now() - 3_600_000 + index * 60_000).toISOString() })
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 600); win.setContentSize(1280, 800) })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800])
    await openActivity(page, 'bots')
    await page.getByTestId('mission-layout-1').click()
    await page.getByTestId(`bot-${bot.id}`).dispatchEvent('click')
    await expect(page.locator('.bots-thread')).toBeVisible()
    const lane = `bot-${bot.id}`
    const app1 = `${lane}:window:app1`, app2 = `${lane}:window:app2`

    const portrait = await frame(app, lane, 'app1', 600, 800)
    await push(app, [portrait])
    await expect(page.locator('.preview-card')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => stageRatio(page)).toBeCloseTo(0.75, 1)
    await settle(page)
    const from = await page.evaluate(() => document.querySelector('.preview-card')!.getBoundingClientRect().height)
    await startSampler(page)
    const landscape = { ...await frame(app, lane, 'app1', 800, 600), at: portrait.at }
    await push(app, [landscape])
    const resized = await stopSampler(page)
    const to = resized.at(-1)!.height
    expect(Math.abs(to - from), 'resize: the card changed height').toBeGreaterThan(10)
    expect(resized.every(one => one.same), 'resize: the card is the same DOM node').toBe(true)
    expect(resized.some(one => one.entering), 'resize: the entry animation does not replay').toBe(false)
    const between = new Set(resized.map(one => Math.round(one.height)).filter(height => height > Math.min(from, to) + 1 && height < Math.max(from, to) - 1))
    expect(between.size, `resize: heights between ${from} and ${to}`).toBeGreaterThanOrEqual(3)
    expect(Math.abs(await stageRatio(page) / (4 / 3) - 1)).toBeLessThan(0.02)
    expectClear(resized, 'resize')

    const second = { ...await frame(app, lane, 'app2', 420, 760), at: portrait.at - 1000 }
    await push(app, [landscape, second])
    await expect(page.locator('.preview-deck-card[data-position="0"]')).toHaveAttribute('data-frame', app2)
    await expect.poll(() => stageRatio(page)).toBeCloseTo(420 / 760, 1)
    await settle(page)
    await startSampler(page)
    await page.locator(`.preview-deck-card[data-frame="${app1}"] .preview-deck-back`).dispatchEvent('click')
    const swapped = await stopSampler(page)
    expect(swapped.at(-1)!.front, 'swap: the clicked app is in front').toBe(app1)
    expect(swapped.filter(one => !one.filled).length, 'swap: the stage is never blank').toBe(0)
    expect(swapped.every(one => one.same), 'swap: the card is the same DOM node').toBe(true)
    expect(swapped.some(one => one.entering), 'swap: the entry animation does not replay').toBe(false)
    expectClear(swapped, 'swap')

    await settle(page)
    const resting = await page.evaluate(() => getComputedStyle(document.querySelector('.preview-deck-card[data-position="1"]')!).transform)
    await startSampler(page)
    const third = await frame(app, lane, 'app3', 1280, 800)
    await push(app, [landscape, second, third])
    const added = await stopSampler(page)
    expect(added.at(-1)!.cards, 'add: three cards').toBe(3)
    expect(added.some(one => one.cardAnimations > 0), 'add: the new back card animates in').toBe(true)
    const final = added.at(-1)!.transforms
    expect(added.some(one => one.transforms.some(value => value !== 'none' && value !== resting && !final.includes(value))), 'add: a back card moves through intermediate transforms').toBe(true)
    expect(added.every(one => one.same && one.filled), 'add: the card stays mounted and filled').toBe(true)
    expectClear(added, 'add')

    await startSampler(page)
    await push(app, [second, third])
    const removed = await stopSampler(page)
    expect(removed.some(one => one.cardLeaving > 0), 'remove: the removed card plays an exit').toBe(true)
    expect(removed.at(-1)!.cardLeaving, 'remove: the exit ends').toBe(0)
    expect(removed.at(-1)!.cards, 'remove: two cards remain').toBe(2)
    expectClear(removed, 'remove')

    await startSampler(page)
    await push(app, [])
    const closed = await stopSampler(page)
    const firstGone = closed.findIndex(one => one.cards === 0)
    expect(firstGone, 'close: the deck unmounts').toBeGreaterThan(0)
    expect(closed.slice(0, firstGone).some(one => one.deckLeaving), 'close: the deck plays an exit before it unmounts').toBe(true)
    await expect(page.locator('.preview-deck')).toHaveCount(0)
  } finally {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
