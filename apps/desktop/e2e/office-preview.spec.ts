import { expect, test, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

test('Office activity events show a localized card without an image', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = await initVault(await mkdtemp(join(tmp, 'office-preview-')), { git: false })
  const bot = await createBot(paths, { name: 'Office preview' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: '메일 확인해 줘', at: new Date().toISOString() })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'office-preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const lane = `bot-${bot.id}`
    await app.evaluate(({ BrowserWindow }, lane) => {
      const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
      send({ type: 'comet:working', channel: lane, working: true })
      send({ type: 'desktop:preview', frames: [{ id: `office:${lane}`, lane, title: 'Outlook', activity: 'Checking your mail', captureState: 'activity', current: true, at: Date.now() }] })
    }, lane)
    await expect(page.getByTestId('preview-card-collapsed')).toHaveCount(0)
    const card = page.getByTestId('preview-card')
    await expect(card.locator('.preview-card-caption')).toHaveText('Outlook · 메일 확인')
    await expect(card.locator('.preview-card-state')).toHaveText('창 없이 Office에서 읽는 중')
    await expect(card.locator('img, canvas')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, lane) => {
      const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
      send({ type: 'comet:working', channel: lane, working: false })
      send({ type: 'chat:done', channel: lane })
    }, lane)
    await expect(card).toHaveCount(0, { timeout: 2000 })
    await page.waitForTimeout(5000)
    await expect(card).toHaveCount(0)
  } finally { await closeTestApp(app) }
})

test('Office activity card can be closed without hover so it stops covering the thread', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = await initVault(await mkdtemp(join(tmp, 'office-preview-')), { git: false })
  const bot = await createBot(paths, { name: 'Office overlap' })
  for (let turn = 0; turn < 14; turn++) {
    await appendBotTurn(paths, bot.id, { role: 'user', text: `질문 ${turn}`, at: new Date().toISOString() })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: `답변 ${turn}\n\n${'긴 설명 문장입니다. '.repeat(12)}`, at: new Date().toISOString() })
  }
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'office-preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const lane = `bot-${bot.id}`
    const thread = page.getByTestId('bots-thread')
    await expect(thread.locator('.bubble-msg')).not.toHaveCount(0)
    expect(await thread.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await app.evaluate(({ BrowserWindow }, lane) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true })
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'desktop:preview', frames: [{ id: `office:${lane}`, lane, title: 'Outlook', activity: 'Checking your mail', captureState: 'activity', current: true, at: Date.now() }] })
    }, lane)
    const card = page.getByTestId('preview-card')
    await expect(card.locator('.preview-card-state')).toHaveText('창 없이 Office에서 읽는 중')
    await page.mouse.move(1, 1)
    const collapse = card.getByRole('button', { name: '접기' })
    await expect.poll(() => collapse.evaluate(node => Number(getComputedStyle(node.parentElement!).opacity))).toBeGreaterThan(0)
    await collapse.click()
    const pill = page.getByTestId('preview-card-collapsed')
    await expect(pill).toBeVisible()
    await expect(card).toHaveCount(0)
    const overlaps = () => page.evaluate(() => {
      const box = document.querySelector('[data-testid="preview-card-collapsed"]')!.getBoundingClientRect()
      const view = document.querySelector('[data-testid="bots-thread"]')!.getBoundingClientRect()
      return [...document.querySelectorAll('[data-testid="bots-thread"] .bubble-msg')].map(node => node.getBoundingClientRect())
        .filter(rect => rect.bottom > view.top && rect.top < view.bottom)
        .some(rect => rect.left < box.right && rect.right > box.left && Math.max(rect.top, view.top) < box.bottom && rect.bottom > box.top)
    })
    await thread.evaluate(node => { node.scrollTop = 0 })
    expect(await overlaps()).toBe(false)
    await thread.evaluate(node => { node.scrollTop = node.scrollHeight })
    expect(await overlaps()).toBe(false)
    await pill.click()
    await expect(card).toBeVisible()
    await expect(card.locator('.preview-card-caption')).toHaveText('Outlook · 메일 확인')
  } finally { await closeTestApp(app) }
})

test('Office activity cards for different apps keep their own look when the current app changes', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = await initVault(await mkdtemp(join(tmp, 'office-preview-')), { git: false })
  const bot = await createBot(paths, { name: 'Office mix' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: '메일이랑 엑셀 확인해 줘', at: new Date().toISOString() })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'office-preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const lane = `bot-${bot.id}`
    const now = Date.now()
    const frames = (outlookCurrent: boolean) => [
      { id: `office:${lane}:Excel`, lane, title: 'Excel', activity: 'Working with documents', captureState: 'activity', current: !outlookCurrent, at: now + 1 },
      { id: `office:${lane}:Outlook`, lane, title: 'Outlook', activity: outlookCurrent ? 'Checking your calendar' : 'Checking your mail', captureState: 'activity', current: outlookCurrent, at: outlookCurrent ? now + 2 : now },
    ]
    const send = (events: unknown[]) => app.evaluate(({ BrowserWindow }, events) => {
      for (const event of events) BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
    }, events)
    await send([{ type: 'comet:working', channel: lane, working: true }, { type: 'desktop:preview', frames: frames(false) }])
    const deck = page.getByTestId('preview-deck')
    const front = deck.locator('[data-position="0"] [data-testid="preview-card"]')
    await expect(front.locator('.preview-card-caption')).toHaveText('Excel · 문서 작업')
    await expect(front.locator('.preview-card-state svg.lucide-file-spreadsheet')).toHaveCount(1)
    await expect(deck.locator('[data-position="1"]')).toHaveAttribute('data-frame', `office:${lane}:Outlook`)
    await expect(deck.locator('[data-position="1"] .preview-deck-title')).toHaveText('Outlook')
    await send([{ type: 'desktop:preview', frames: frames(true) }])
    await expect(deck.locator('[data-position="1"]')).toHaveAttribute('data-frame', `office:${lane}:Outlook`)
    await expect(deck.locator('[data-position="1"] .preview-deck-title')).toHaveText('Outlook')
    await expect(front.locator('.preview-card-state svg.lucide-file-spreadsheet')).toHaveCount(1)
    await expect(front.locator('.preview-card-caption')).toHaveText(/^Excel/)
    await expect(front.locator('.preview-card-caption')).not.toContainText('Outlook')
    await deck.locator('[data-position="1"] .preview-deck-back').press('Enter')
    await expect(front.locator('.preview-card-caption')).toHaveText('Outlook · 일정 확인')
    await expect(front.locator('.preview-card-state svg.lucide-calendar')).toHaveCount(1)
    await expect(deck.locator('[data-position="1"]')).toHaveAttribute('data-frame', `office:${lane}:Excel`)
    await expect(deck.locator('[data-position="1"] .preview-deck-title')).toHaveText('Excel')
  } finally { await closeTestApp(app) }
})

for (const length of ['long', 'short'] as const) test(`Office activity card arriving and leaving leaves a ${length} thread exactly where it was`, async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = await initVault(await mkdtemp(join(tmp, 'office-preview-')), { git: false })
  const bot = await createBot(paths, { name: `Office ${length} shift` })
  for (let turn = 0; turn < (length === 'long' ? 14 : 1); turn++) {
    await appendBotTurn(paths, bot.id, { role: 'user', text: `질문 ${turn}`, at: new Date().toISOString() })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: `답변 ${turn}\n\n${'긴 설명 문장입니다. '.repeat(length === 'long' ? 12 : 1)}`, at: new Date().toISOString() })
  }
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'office-preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const lane = `bot-${bot.id}`
    const thread = page.getByTestId('bots-thread')
    await expect(thread.locator('.bubble-msg')).toHaveCount(length === 'long' ? 28 : 2)
    const settle = () => page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)))
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    })
    await settle()
    const scroll = await thread.evaluate((node, long) => {
      if (long) node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) / 2)
      const view = node.getBoundingClientRect()
      const bubble = [...node.querySelectorAll<HTMLElement>('.bubble-msg')].find(one => { const box = one.getBoundingClientRect(); return box.top >= view.top && box.bottom <= view.bottom })!
      bubble.dataset.probe = ''
      return { top: node.scrollTop, overflows: node.scrollHeight > node.clientHeight }
    }, length === 'long')
    if (length === 'long') expect(scroll.top).toBeGreaterThan(0)
    else expect(scroll).toEqual({ top: 0, overflows: false })
    const probe = thread.locator('[data-probe]')
    const geometry = () => page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>('[data-testid="bots-thread"]')!
      const box = thread.getBoundingClientRect()
      return [document.querySelector('[data-probe]')!.getBoundingClientRect().top, box.top, box.height, thread.scrollTop, document.querySelector('.bots-chat > .bots-write')!.getBoundingClientRect().top]
    })
    const near = (now: number[], then: number[]) => now.every((value, index) => Math.abs(value - then[index]!) <= 1)
    const before = await geometry()
    const card = page.getByTestId('preview-card')
    await app.evaluate(({ BrowserWindow }, lane) => {
      const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
      send({ type: 'comet:working', channel: lane, working: true })
      send({ type: 'desktop:preview', frames: [{ id: `office:${lane}`, lane, title: 'Outlook', activity: 'Checking your mail', captureState: 'activity', current: true, at: Date.now() }] })
    }, lane)
    await expect(card.locator('.preview-card-state')).toHaveText('창 없이 Office에서 읽는 중')
    await settle()
    expect(near(await geometry(), before), `mounted ${await geometry()} vs ${before}`).toBe(true)
    const covers = await page.evaluate(() => document.querySelector('[data-testid="preview-card"]')!.getBoundingClientRect().bottom - document.querySelector('[data-testid="bots-thread"]')!.getBoundingClientRect().top)
    expect(covers).toBeLessThanOrEqual(1)
    await expect(probe).toBeInViewport()
    await app.evaluate(({ BrowserWindow }, lane) => {
      const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
      send({ type: 'desktop:preview', frames: [] })
      send({ type: 'comet:working', channel: lane, working: false })
    }, lane)
    await expect(card).toHaveCount(0)
    await settle()
    expect(near(await geometry(), before), `removed ${await geometry()} vs ${before}`).toBe(true)
    await expect(probe).toBeInViewport()
  } finally { await closeTestApp(app) }
})
