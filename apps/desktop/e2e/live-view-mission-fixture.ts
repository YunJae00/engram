import { expect, test, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function checkMissionLiveView(app: ElectronApplication, page: Page, siteUrl: string, browserPort: number, output: string): Promise<void> {
  const bots = await page.evaluate(async () => {
    // The watched conversation, not the primary Engram bot that a v2 list always starts with.
    const first = (await window.engram.botsList()).find((bot) => bot.name === 'Watching')!
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
  // One chat view: there is no split view to watch them side by side.
  await expect(page.locator('[data-testid^="mission-"]')).toHaveCount(0)
  await expect(page.locator('.mini-chat')).toHaveCount(0)
  // Each bot's sidebar row opens its chat with its own page beside it, never another bot's.
  const open = async (index: number, url: string) => {
    const row = page.getByTestId(`bot-${bots[index]!.id}`)
    await row.click()
    await expect(row).toHaveClass(/active/)
    await expect(page.getByTestId('bot-empty')).toContainText(bots[index]!.name)
    await expect(page.getByTestId('bots-input')).toBeEditable()
    await expect(page.getByTestId('live-address')).toHaveValue(url)
    await expect(page.getByTestId('web-pane').locator('canvas[data-painted]')).toBeVisible({ timeout: 20000 })
  }
  for (const index of [1, 2, 3]) await open(index, `${siteUrl}typed?q=${index + 1}`)
  await open(0, `${siteUrl}clicked`)
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
      // No view watches several lanes any more, so the test holds the lease itself.
      await window.engram.missionWatch(lanes)
      await Promise.all(lanes.map((lane) => window.engram.agentGo(`${url}motion`, lane)))
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await window.engram.missionWatch(lanes)
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
  await writeFile(join(output, 'single-live.png'), Buffer.from(shot, 'base64'))
  await open(1, `${siteUrl}typed?q=1`)
  // Selection is not restored on load; the chosen chat still opens from its row with its own page.
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await open(3, `${siteUrl}typed?q=3`)
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
