import { createBot } from '../../packages/core/src/index.ts'
import { settle } from './lib/chat-layout.mjs'
import { pngFrame, sendAppFrames } from './lib/frame-fixture.mjs'

const FRAMES = [
  { name: 'portrait', width: 420, height: 760 },
  { name: 'landscape', width: 1280, height: 800 },
  { name: 'very tall', width: 300, height: 1400 },
]

export async function run(page, { app, paths, expect, openActivity }) {
  const bot = await createBot(paths, { name: 'Preview aspect fixture' })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(600, 560)
    win.setSize(1280, 800)
    win.showInactive()
  })
  await page.reload()
  await openActivity(page, 'bots')
  await page.getByTestId(`bot-${bot.id}`).click()

  const card = page.getByTestId('preview-card')
  const evidence = []
  for (const frameSize of FRAMES) {
    const frame = pngFrame(frameSize)
    await sendAppFrames(app, `bot-${bot.id}`, [frameSize.name], frame)
    await expect(card).toBeVisible()
    await expect.poll(() => card.locator('.preview-card-stage img, .preview-card-stage canvas').evaluate(element =>
      element instanceof globalThis.HTMLImageElement ? [element.naturalWidth, element.naturalHeight] : [element.width, element.height],
    )).toEqual([frame.width, frame.height])

    for (const windowWidth of [1280, 720]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), windowWidth)
      await expect.poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight])).toEqual([windowWidth, 800])
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async value => {
          const settings = await globalThis.window.engram.settingsGet()
          await globalThis.window.engram.settingsSet({ ...settings, theme: value })
        }, theme)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await settle(page)

        const measured = await card.evaluate(node => {
          const stage = node.querySelector('.preview-card-stage')
          const painted = stage.querySelector('img, canvas')
          const chat = node.closest('.bots-chat')
          const stageBox = stage.getBoundingClientRect()
          const paintedBox = painted.getBoundingClientRect()
          const frameWidth = painted instanceof globalThis.HTMLImageElement ? painted.naturalWidth : painted.width
          const frameHeight = painted instanceof globalThis.HTMLImageElement ? painted.naturalHeight : painted.height
          const objectFit = globalThis.getComputedStyle(painted).objectFit
          const scale = objectFit === 'cover'
            ? Math.max(paintedBox.width / frameWidth, paintedBox.height / frameHeight)
            : objectFit === 'none' ? 1 : Math.min(paintedBox.width / frameWidth, paintedBox.height / frameHeight)
          const content = objectFit === 'fill'
            ? { width: paintedBox.width, height: paintedBox.height }
            : { width: frameWidth * scale, height: frameHeight * scale }
          const cropped = content.width > paintedBox.width + 1 || content.height > paintedBox.height + 1
            || paintedBox.width > stageBox.width + 1 || paintedBox.height > stageBox.height + 1
          const contentAspectOk = objectFit !== 'fill' || Math.abs(paintedBox.width / paintedBox.height / (frameWidth / frameHeight) - 1) <= 0.03
          const cardBox = node.getBoundingClientRect()
          const noBars = Math.max(Math.abs(cardBox.width - stageBox.width), Math.abs(cardBox.height - stageBox.height),
            Math.abs(paintedBox.width - stageBox.width), Math.abs(paintedBox.height - stageBox.height)) <= 2
          const deck = node.closest('.preview-deck')
          return {
            stage: { width: stageBox.width, height: stageBox.height },
            cardMax: parseFloat(deck?.style.getPropertyValue('--live-fit-width')) || Infinity,
            noBars,
            painted: { width: paintedBox.width, height: paintedBox.height },
            content,
            chatHeight: chat.getBoundingClientRect().height,
            objectFit,
            cropped,
            contentAspectOk,
          }
        })
        const heightLimit = measured.chatHeight / 2
        const aspectOk = Math.abs(measured.stage.width / measured.stage.height / (frame.width / frame.height) - 1) <= 0.03
        const heightOk = measured.stage.height <= heightLimit + 1
        // The card is as large as it may be: either the height cap or the width limit binds.
        const fills = Math.abs(measured.stage.height - heightLimit) <= 1
          || measured.stage.width >= Math.min(320, measured.cardMax) - 1
        evidence.push({
          frame: frameSize.name,
          frameSize: { width: frame.width, height: frame.height },
          windowWidth,
          theme,
          ...measured,
          aspectOk,
          heightOk,
          fills,
        })
      }
    }
  }

  const portrait = evidence.filter(entry => entry.frame === 'portrait')
  const landscape = evidence.filter(entry => entry.frame === 'landscape')
  const portraitTaller = portrait.every(entry => entry.stage.height > landscape.find(other =>
    other.windowWidth === entry.windowWidth && other.theme === entry.theme,
  ).stage.height)
  return {
    ok: evidence.length === 12 && evidence.every(entry => entry.aspectOk && entry.heightOk && entry.fills && entry.noBars && entry.contentAspectOk && !entry.cropped) && portraitTaller,
    evidence,
  }
}
