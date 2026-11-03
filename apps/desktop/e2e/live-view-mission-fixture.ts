import { expect, test, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandPreview, openActivity } from './navigation.js'

export async function checkMissionLiveView(app: ElectronApplication, page: Page, siteUrl: string, browserPort: number, output: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(2600, 1600))
  const bots = await page.evaluate(async () => {
    const first = (await window.engram.botsList())[0]!
    const second = await window.engram.botCreate({ name: 'Parallel watch', purpose: '' })
    const third = await window.engram.botCreate({ name: 'Third watch', purpose: '' })
    const fourth = await window.engram.botCreate({ name: 'Fourth watch', purpose: '' })
    return [first, second, third, fourth]
  })
  await page.evaluate(async ({ url, ids }) => {
    await Promise.all(ids.map((id, index) => window.engram.agentGo(`${url}typed?q=${index + 2}`, `bot-${id}`)))
  }, { url: siteUrl, ids: bots.slice(1).map((bot) => bot.id) })
  const before = await page.evaluate(() => window.engram.agentState())
  const previews = await page.evaluate((ids) => window.engram.missionFrames(ids.map((id) => `bot-${id}`)), bots.map((bot) => bot.id))
  expect(previews[0]!.url).toBe(`${siteUrl}clicked`)
  expect(previews.slice(1).map((preview) => preview.url)).toEqual([2, 3, 4].map((index) => `${siteUrl}typed?q=${index}`))
  await expect.poll(async () => {
    const ready = await page.evaluate((ids) => window.engram.missionFrames(ids.map((id) => `bot-${id}`)), bots.map((bot) => bot.id))
    return ready.every((preview) => Boolean(preview.data))
  }, { timeout: 30000 }).toBe(true)
  expect(await page.evaluate(() => window.engram.agentState())).toEqual(before)
  await openActivity(page, 'mission')
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  // The selected conversation occupies the first pane; replace it deliberately.
  await page.getByTestId('mission-tile-0').locator('.mission-change').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Parallel watch' }).click()
  await page.getByTestId('mission-add-1').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Third watch' }).click()
  // Each tile shows its page as a corner preview until it is opened there.
  const openTile = async (index: number) => {
    const tile = page.getByTestId(`mission-tile-${index}`)
    await expandPreview(tile)
    await tile.getByRole('button', { name: 'Open full browser', exact: true }).click()
    await expect(tile.locator('.mission-tile-body')).toHaveAttribute('data-web-open', 'true')
  }
  for (const index of [0, 1]) await openTile(index)
  await expect(page.locator('.mission-preview canvas[data-painted]')).toHaveCount(2, { timeout: 15000 })
  const previewsFit = () => page.locator('.mission-preview canvas').evaluateAll((nodes) => nodes.every(node => {
    const width = node.closest('.mission-preview')!.getBoundingClientRect().width
    return (node as HTMLCanvasElement).width === Math.max(360, Math.min(1920, Math.round(width / 8) * 8)) * 2
  }))
  await expect.poll(previewsFit, { timeout: 15000 }).toBe(true)
  await expect(page.locator('.mini-chat')).toHaveCount(2)
  await page.getByTestId('mission-add-2').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Watching', exact: true }).click()
  await page.getByTestId('mission-add-3').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Fourth watch', exact: true }).click()
  for (const index of [2, 3]) await openTile(index)
  await expect(page.locator('.mission-preview canvas[data-painted]')).toHaveCount(4, { timeout: 20000 })
  await expect.poll(previewsFit, { timeout: 20000 }).toBe(true)
  const simultaneous = await page.evaluate(async ({ url, ids }) => {
    const lanes = ids.map((id) => `bot-${id}`)
    const counts = lanes.map(() => 0)
    let measuring = false
    const off = window.engram.onEvent((event) => {
      if (!measuring || event.type !== 'mission:frame' || !event.frame.data) return
      const index = lanes.indexOf(event.frame.lane)
      if (index >= 0) counts[index]!++
    })
    try {
      await Promise.all(lanes.map((lane) => window.engram.agentGo(`${url}motion`, lane)))
      await new Promise((resolve) => setTimeout(resolve, 1000))
      measuring = true
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return counts
    } finally {
      off()
      await Promise.all(lanes.map((lane, index) => window.engram.agentGo(`${url}typed?q=${index}`, lane)))
    }
  }, { url: siteUrl, ids: bots.map((bot) => bot.id) })
  console.log('simultaneous motion frames in 3s:', simultaneous)
  expect(simultaneous.every((count) => count > 15)).toBe(true)
  // Two captures wake the hidden compositor before reading its current frame.
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('index.html'))
    if (!win) throw new Error('no app window to photograph')
    await win.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(output, 'mission-live.png'), Buffer.from(shot, 'base64'))
  await page.getByTestId('mission-layout-2').click()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  // A title picker replaces this exact seat, not the first available one.
  await page.getByRole('button', { name: 'Chat for panel 2', exact: true }).click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Fourth watch', exact: true }).click()
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  const motion = await page.evaluate(async ({ url, id }) => {
    let count = 0
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const off = window.engram.onEvent((event) => {
      if (event.type === 'mission:frame' && event.frame.lane === `bot-${id}` && event.frame.url === `${url}motion` && event.frame.data && ++count >= 2) ready()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await window.engram.agentGo(`${url}motion`, `bot-${id}`)
      await Promise.race([started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Replacement lane stream did not start')), 20000) })])
      count = 0
      await new Promise(resolve => setTimeout(resolve, 2500))
      return count
    } finally { clearTimeout(timer); off() }
  }, { url: siteUrl, id: bots[3]!.id })
  expect(motion).toBeGreaterThan(10)
  await page.getByRole('button', { name: 'Open Parallel watch', exact: true }).first().click()
  await expect(page.locator('.bots-head-name')).toHaveText('Parallel watch')
  await openActivity(page, 'mission')
  await expect(page.getByTestId('mission-tile-0').locator('.mission-name')).toHaveText('Parallel watch')
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await openActivity(page, 'mission')
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  await page.getByRole('button', { name: 'Open Fourth watch', exact: true }).first().click()
  await expect(page.locator('.bots-head-name')).toHaveText('Fourth watch')
  await page.setViewportSize({ width: 1680, height: 950 })
  await page.evaluate(({ url, id }) => window.engram.agentGo(`${url}scroll`, `bot-${id}`), { url: siteUrl, id: bots[3]!.id })
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}scroll`)
  await page.getByTestId('web-pane').evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)) })
  await page.evaluate(async (lane) => {
    const rect = document.querySelector('.web-pane-stage')!.getBoundingClientRect()
    const width = Math.round(rect.width / 8) * 8, height = Math.round(rect.height / 8) * 8
    for (let resize = 0; resize < 8; resize++) {
      await Promise.all([window.engram.agentResize(lane, width - 64, height), window.engram.agentRefresh()])
      await Promise.all([window.engram.agentResize(lane, width, height), window.engram.agentRefresh()])
    }
  }, `bot-${bots[3]!.id}`)
  const sharpWidth = await page.locator('.web-pane-stage').evaluate((node) => Math.max(360, Math.min(1920, Math.round(node.getBoundingClientRect().width / 8) * 8)) * 2)
  // Navigation commits before the new document can receive wheel input.
  try {
    await expect.poll(() => page.getByTestId('web-pane').locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return { format: canvas.dataset.format, width: canvas.width, pixel: Array.from(pixel) }
    }), { timeout: 20000 }).toEqual({ format: 'png', width: sharpWidth, pixel: [240, 40, 40, 255] })
    expect((await page.evaluate(() => window.engram.agentState())).lane).toBe(`bot-${bots[3]!.id}`)
    await page.evaluate((id) => window.engram.agentInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 4000, deltaX: 0 }, `bot-${id}`), bots[3]!.id)
    await expect.poll(() => page.getByTestId('web-pane').locator('canvas').evaluate((node, width) => {
      const canvas = node as HTMLCanvasElement
      const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return canvas.dataset.format === 'png' && canvas.width === width && pixel[2]! > 180 && pixel[0]! < 60
    }, sharpWidth), { timeout: 20000 }).toBe(true)
  } catch (error) {
    console.log('input lane', JSON.stringify(await page.evaluate(() => window.engram.agentState())))
    const profile = await app.evaluate(({ app }) => app.getPath('userData'))
    console.log('input main log', await readFile(join(profile, 'logs/engram-main.log'), 'utf8').catch(() => 'unavailable'))
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`)
    try {
      const actual = browser.contexts()[0]!.pages().find((entry) => entry.url() === `${siteUrl}scroll`)!
      const cdp = await actual.context().newCDPSession(actual)
      console.log('capture diagnostics', JSON.stringify({ viewport: actual.viewportSize(), metrics: await cdp.send('Page.getLayoutMetrics'), document: await actual.evaluate(() => ({ width: innerWidth, height: innerHeight, y: scrollY, scale: devicePixelRatio, wheels: (window as unknown as { wheels?: number[][] }).wheels, html: document.body.innerHTML })) }))
      const mirror = await page.getByTestId('web-pane').locator('canvas').evaluate((node) => (node as HTMLCanvasElement).toDataURL().split(',')[1]!)
      await test.info().attach('mirrored-page', { body: Buffer.from(mirror, 'base64'), contentType: 'image/png' })
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      await test.info().attach('direct-page', { body: Buffer.from(shot.data, 'base64'), contentType: 'image/png' })
      await cdp.detach()
    } finally { await browser.close() }
    throw error
  }
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
}
