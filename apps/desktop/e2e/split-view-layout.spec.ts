import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp, openActivity } from './navigation.js'
import { appendBotTurn, initVault, type Bot } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let bots: Bot[]

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-split-view-vault-'))
  const paths = await initVault(vault, { git: false })
  const at = new Date().toISOString()
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-split-view-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  bots = await page.evaluate(async () => [await window.engram.botCreate({ name: 'test', purpose: '' }), await window.engram.botCreate({ name: '새 코멧', purpose: '' })]) as Bot[]
  for (const bot of bots) {
    for (let turn = 1; turn <= 3; turn++) {
      await appendBotTurn(paths, bot.id, { role: 'user', text: `${bot.name} question ${turn}`, at })
      await appendBotTurn(paths, bot.id, { role: 'assistant', text: `${bot.name} answer ${turn}: a short reply that reads like a normal chat turn.`, at })
    }
  }
  await page.evaluate((ids) => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map((bot) => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => { await closeTestApp(app) })

async function emit(events: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, events) => {
    const win = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('index.html'))!
    for (const event of events) win.webContents.send('engram:event', event)
  }, events)
}

async function shot(name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes('index.html'))!
    // Wake a hidden window's compositor before capturing the current frame.
    await win.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  await test.info().attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
}

async function settle(): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => undefined)))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

type Geometry = { cover: { w: number; h: number }; dark: string[]; card: { inside: boolean; overlaps: boolean } | null }

function geometry(index: number): Promise<Geometry> {
  return page.getByTestId(`mission-tile-${index}`).evaluate((tile) => {
    const body = tile.querySelector('.mission-tile-body')!.getBoundingClientRect()
    const thread = tile.querySelector('.mini-chat-thread')!.getBoundingClientRect()
    const write = tile.querySelector('.mini-chat-write')!.getBoundingClientRect()
    const top = Math.min(thread.top, write.top), bottom = Math.max(thread.bottom, write.bottom)
    const left = Math.min(thread.left, write.left), right = Math.max(thread.right, write.right)
    const probe = document.createElement('div')
    probe.style.background = 'var(--canvas-bg)'
    tile.append(probe)
    const canvasBg = getComputedStyle(probe).backgroundColor
    probe.remove()
    const dark: string[] = []
    for (const node of tile.querySelectorAll<HTMLElement>('.mission-tile-body *')) {
      const box = node.getBoundingClientRect()
      if (box.width * box.height <= body.width * body.height * 0.25) continue
      const style = getComputedStyle(node)
      if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) continue
      const rgba = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
      const opaque = (rgba[3] ?? 1) > 0.9
      const nearBlack = rgba[0]! + rgba[1]! + rgba[2]! < 60
      if (!opaque || (!nearBlack && style.backgroundColor !== canvasBg)) continue
      const painted = node.querySelector('canvas[data-painted], img, .bubble-msg, button, textarea')
      if (!painted) dark.push(`${node.className} ${Math.round(box.width)}x${Math.round(box.height)} ${style.backgroundColor}`)
    }
    const deck = tile.querySelector('[data-testid=preview-deck]')?.getBoundingClientRect()
    const outer = tile.getBoundingClientRect()
    const hits = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    return {
      cover: { w: (right - left) / body.width, h: (bottom - top) / body.height },
      dark,
      card: deck ? {
        inside: deck.left >= outer.left - 0.5 && deck.right <= outer.right + 0.5 && deck.top >= outer.top - 0.5 && deck.bottom <= outer.bottom + 0.5,
        overlaps: hits(deck, thread) || hits(deck, write),
      } : null,
    }
  })
}

async function expectFullChat(index: number, withCard: boolean): Promise<void> {
  const tile = page.getByTestId(`mission-tile-${index}`)
  await expect(tile.locator('.mission-tile-body')).toHaveAttribute('data-web-open', 'false')
  await expect(tile.locator('.mission-name')).toHaveText(bots[index]!.name)
  await expect(tile.locator('.bubble-msg', { hasText: `${bots[index]!.name} answer 3` })).toBeVisible()
  await expect(tile.locator('.mini-chat-write textarea')).toBeEditable()
  await settle()
  const result = await geometry(index)
  const report = JSON.stringify(result)
  expect(result.cover.h, report).toBeGreaterThanOrEqual(0.85)
  expect(result.cover.w, report).toBeGreaterThanOrEqual(0.85)
  expect(result.dark, report).toEqual([])
  if (!withCard) { expect(result.card, report).toBeNull(); return }
  expect(result.card, report).not.toBeNull()
  expect(result.card!.inside, report).toBe(true)
  expect(result.card!.overlaps, report).toBe(false)
}

test('two running chats in split view fill their panes with conversation, not black space', async () => {
  await openActivity(page, 'mission')
  await page.getByTestId('mission-layout-2').click()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText(bots[1]!.name)
  const lanes = bots.map((bot) => `bot-${bot.id}`)
  const size = { width: 640, height: 400 }
  const frame = await app.evaluate(({ nativeImage }, size) => {
    const pixels = Buffer.alloc(size.width * size.height * 4)
    for (let i = 0; i < pixels.length; i += 4) pixels.set(i < pixels.length / 3 ? [72, 40, 24, 255] : [252, 250, 248, 255], i)
    return nativeImage.createFromBuffer(pixels, size).toDataURL()
  }, size)
  const appFrame = () => ({ type: 'desktop:preview', frames: [{ id: `${lanes[0]}:window:1`, lane: lanes[0], title: 'Split page', at: Date.now(), captureState: 'ready', current: true, data: frame }] })
  await emit([...lanes.map((lane) => ({ type: 'comet:working', channel: lane, working: true })), appFrame()])
  for (const index of [0, 1]) await expect(page.getByTestId(`mission-tile-${index}`)).toHaveAttribute('data-state', /running|waiting/)
  const card = page.getByTestId('mission-tile-0').getByTestId('preview-card')
  await expect(card.locator('canvas[data-painted], img').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('mission-tile-1').getByTestId('preview-card')).toHaveCount(0)

  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme)
    await expectFullChat(0, true)
    await expectFullChat(1, false)
    await shot(`split-view-${theme}`)
  }

  // A second frame while the other tile keeps its conversation.
  await emit([appFrame()])
  await expectFullChat(1, false)

  const web = (index: number) => page.getByTestId(`mission-tile-${index}`).locator('.mini-chat-write .composer-web')
  const addMenu = page.getByTestId('mission-tile-0').getByRole('button', { name: 'Add to conversation', exact: true })
  await addMenu.click()
  await web(0).click()
  const modal = page.getByTestId('mission-browser-dialog')
  await expect(modal).toBeVisible()
  await shot('split-view-compact-browser')
  await modal.getByRole('button', { name: 'Close browser', exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expectFullChat(0, true)

  await page.setViewportSize({ width: 2600, height: 1400 })
  await expect.poll(() => page.getByTestId('mission-tile-0').evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(960)
  await addMenu.click()
  await web(0).click()
  const body = page.getByTestId('mission-tile-0').locator('.mission-tile-body')
  await expect(body).toHaveAttribute('data-web-open', 'true')
  await settle()
  const opened = await body.evaluate((node) => {
    const own = node.getBoundingClientRect()
    const surface = node.querySelector('.orbit-surface')!.getBoundingClientRect()
    const chat = node.querySelector('.mini-chat-write')!.getBoundingClientRect()
    return { surface: surface.width * surface.height / (own.width * own.height), chat: chat.width > 200 && chat.bottom <= own.bottom + 0.5 }
  })
  expect(opened.surface, JSON.stringify(opened)).toBeGreaterThan(0.3)
  expect(opened.chat, JSON.stringify(opened)).toBe(true)
  await expect(page.getByTestId('mission-tile-0').getByTestId('orbit-surface')).toBeVisible()
  await shot('split-view-inline-page')
  await addMenu.click()
  await web(0).click()
  await expectFullChat(0, true)
  await expectFullChat(1, false)
  await page.setViewportSize({ width: 1440, height: 900 })
})
