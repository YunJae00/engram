// The live card: a comet's page shown as an overlay card in its chat. A real
// PNG frame arrives through the main process, the card paints it without
// narrowing the chat, and a pointer drag across it lands on the card and
// leaves it packed above the thread.
/* global document, window */
import { describeBlocks, measureChat, packedBlocks } from './lib/chat-layout.mjs'
import { pngFrame, showWebFrame } from './lib/frame-fixture.mjs'

const BOT = 'Live overlay'
const URL = 'https://example.test/live'

// The mirror paints frames only when the browser is external; the Windows native surface would wait on a real window.
export const launch = {
  env: { ENGRAM_BROWSER_EXTERNAL: '1' },
  seed: (core, paths) => core.createBot(paths, { name: BOT, purpose: '' }),
}

async function dragAcross(page, card) {
  await page.evaluate(() => {
    const log = { down: 0, moves: 0, movesOnCard: 0, movesInChat: 0, up: 0, upInChat: false }
    const card = document.querySelector('.preview-card')
    const chat = document.querySelector('.bots-chat')
    const hit = (event) => document.elementFromPoint(event.clientX, event.clientY)
    const onDown = () => { log.down++ }
    const onMove = (event) => {
      log.moves++
      const target = hit(event)
      if (card.contains(target)) log.movesOnCard++
      if (chat.contains(target)) log.movesInChat++
    }
    const onUp = (event) => { log.up++; log.upInChat = chat.contains(hit(event)) }
    card.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    globalThis.__liveDrag = () => {
      card.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      return log
    }
  })
  const box = await card.boundingBox()
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const to = { x: from.x - box.width, y: from.y + box.height }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - box.width * 0.3, from.y, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  return { from, to, log: await page.evaluate(() => globalThis.__liveDrag()) }
}

export async function run(page, { app, expect, openActivity }) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: BOT }).click()
  const lane = await page.evaluate(async (name) => `bot-${(await globalThis.engram.botsList()).find((bot) => bot.name === name).id}`, BOT)
  const frame = pngFrame({ width: 1280, height: 800 })
  await showWebFrame(app, { lane, url: URL, frame })

  const card = page.getByTestId('preview-card')
  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })
  await expect(card.locator('canvas')).toHaveAttribute('data-format', 'png')
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  await expect(card.locator('.preview-card-label')).toContainText('example.test')
  const painted = await card.locator('canvas').evaluate((canvas) => [canvas.width, canvas.height])
  expect(painted).toEqual([frame.width, frame.height])

  const before = await measureChat(page)
  const packedBefore = packedBlocks(before)
  expect(packedBefore.reasons, 'before the drag').toEqual([])

  const drag = await dragAcross(page, card)
  expect(drag.log.down, 'the press landed on the card').toBe(1)
  expect(drag.log.movesOnCard, 'moves over the card reached it').toBeGreaterThan(0)
  expect(drag.log.movesInChat, 'every move stayed in the chat').toBe(drag.log.moves)
  expect(drag.log.upInChat, 'the release stayed in the chat').toBe(true)

  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '')
  await expect(page.getByTestId('bots-input')).toBeVisible()
  const after = await measureChat(page)
  const packedAfter = packedBlocks(after)
  expect(packedAfter.reasons, 'after the drag').toEqual([])
  expect(Math.abs(after.chat.width - before.chat.width)).toBeLessThan(2)

  const point = ({ x, y }) => `${Math.round(x)},${Math.round(y)}`
  return {
    ok: true,
    evidence: `agent:frame ${frame.width}x${frame.height} png painted preview-card for ${lane} with no web pane; ${describeBlocks(before)}; `
      + `drag ${point(drag.from)} to ${point(drag.to)}: ${drag.log.movesOnCard}/${drag.log.moves} moves on the card, all in the chat; after: ${describeBlocks(after)}`,
  }
}
