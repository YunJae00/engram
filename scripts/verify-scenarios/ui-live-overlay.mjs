/* global document, window, PointerEvent, getComputedStyle */
import { createBot, appendBotTurn } from '../../packages/core/src/index.ts'
import { describeBlocks, measureChat, packedBlocks } from './lib/chat-layout.mjs'
import { pngFrame, showWebFrame, sendEvents } from './lib/frame-fixture.mjs'

const BOT = 'Live overlay'
const URL = 'https://example.test/live'

async function dragAcross(page, card, unchanged) {
  const box = await card.boundingBox()
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const to = { x: from.x - box.width, y: from.y + box.height }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - box.width * 0.3, from.y, { steps: 6 })
  await unchanged()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await unchanged()
  await page.mouse.up()
  return { from, to }
}

export async function run(page, { app, paths, expect, openActivity }) {
  const bot = await createBot(paths, { name: BOT, purpose: '' })
  const other = await createBot(paths, { name: 'Other overlay lane', purpose: '' })
  for (const role of ['user', 'assistant']) await appendBotTurn(paths, bot.id, { role, text: `Overlay geometry ${role}`, at: new Date().toISOString() })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await page.reload()
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: BOT }).click()
  const lane = await page.evaluate(async (name) => `bot-${(await globalThis.engram.botsList()).find((bot) => bot.name === name).id}`, BOT)
  const frame = pngFrame({ width: 1280, height: 800 })
  const geometry = () => page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector)
      const box = node.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height, node.scrollHeight, node.scrollTop]
    }
    return [rect('.bots-thread'), rect('.bots-chat textarea'), ...[...document.querySelectorAll('.bubble-msg')].slice(0, 2).map(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height] })]
  })
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
  const baseline = await geometry()
  await showWebFrame(app, { lane, url: URL, frame })

  const settle = () => page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
  const card = page.getByTestId('preview-card')
  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })
  await expect(card.locator('canvas')).toHaveAttribute('data-format', 'png')
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  await expect(card.locator('.preview-card-label')).toContainText('example.test')
  const painted = await card.locator('canvas').evaluate((canvas) => [canvas.width, canvas.height])
  expect(painted).toEqual([frame.width, frame.height])
  expect(await card.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(256, 320, 1, 1).data])).toEqual([220, 60, 60, 255])

  expect(await card.evaluate(node => getComputedStyle(node).animationName)).toBe('preview-card-in')
  await settle()
  expect(await geometry()).toEqual(baseline)
  const relative = () => page.getByTestId('preview-deck').evaluate(node => {
    const box = node.getBoundingClientRect(), chat = node.parentElement.getBoundingClientRect()
    return { x: box.x - chat.x, y: box.y - chat.y, right: chat.right - box.right }
  })
  const switchTabs = async () => {
    await openActivity(page, 'list')
    await expect(card).toBeHidden()
    await openActivity(page, 'bots')
    await expect(card).toBeVisible()
    await settle()
  }
  const deck = page.getByTestId('preview-deck')
  const begin = async () => {
    const box = await card.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
  }
  const anchored = await relative()
  await switchTabs()
  expect(await relative()).toEqual(anchored)
  for (const width of [1100, 1600, 1400]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    await expect.poll(async () => (await relative()).right).toBeCloseTo(anchored.right, 0)
    expect(await page.getByTestId('preview-deck').evaluate(node => node.style.left)).toBe('')
  }
  await settle()
  const before = await measureChat(page)
  const packedBefore = packedBlocks(before)
  expect(packedBefore.reasons, 'before the drag').toEqual([])
  for (const [trigger, menu] of [[page.getByTestId('workspace-switcher'), 'workspace-menu'], [page.locator('.bots-chat').getByTestId('model-picker'), 'model-picker-menu']]) {
    await trigger.click()
    await expect(page.getByTestId(menu)).toBeVisible()
    expect(packedBlocks(await measureChat(page)).reasons, `${menu} open`).toEqual([])
    await begin()
    await page.mouse.up()
    await expect(page.getByTestId(menu)).toHaveCount(0)
    expect(await deck.evaluate(node => node.style.left)).toBe('')
  }

  const drag = await dragAcross(page, card, async () => expect(await geometry()).toEqual(baseline))
  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '')
  await expect(page.getByTestId('bots-input')).toBeVisible()
  const after = await measureChat(page)
  const packedAfter = packedBlocks(after)
  expect(packedAfter.reasons, 'after the drag').toEqual([])
  expect(Math.abs(after.card.left - (before.card.left - before.card.width))).toBeLessThan(2)
  expect(Math.abs(after.card.top - (before.card.top + before.card.height))).toBeLessThan(2)
  expect(await geometry()).toEqual(baseline)
  expect(await page.evaluate(() => document.getSelection().toString())).toBe('')
  const origin = await card.boundingBox()
  await page.mouse.move(500, 500)
  expect(await card.boundingBox()).toEqual(origin)
  for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'tab']) {
    await begin()
    await page.mouse.move(origin.x + 80, origin.y + 30)
    if (cancellation === 'tab') {
      await page.getByTestId('workspace-switcher').evaluate(node => node.click())
      await page.getByTestId('activity-list').evaluate(node => node.click())
      await expect(card).toBeHidden()
      await openActivity(page, 'bots')
      await expect(card).toBeVisible()
      await settle()
    }
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else if (cancellation === 'Escape') await page.keyboard.press('Escape')
    else if (cancellation === 'lostpointercapture') await deck.evaluate(node => node.releasePointerCapture(1))
    else await deck.evaluate((node, type) => node.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true })), cancellation)
    await page.mouse.up()
    expect(await card.boundingBox()).toEqual(origin)
    await expect(deck).not.toHaveAttribute('data-dragging')
    expect(await geometry()).toEqual(baseline)
  }
  await begin()
  await page.mouse.move(0, 0, { steps: 10 })
  await page.mouse.up()
  let clamped = await measureChat(page)
  expect(clamped.card.left).toBeCloseTo(clamped.chat.left, 0)
  expect(clamped.card.top).toBeCloseTo(clamped.chat.top, 0)
  await begin()
  await page.mouse.move(2000, 1500, { steps: 10 })
  await page.mouse.up()
  clamped = await measureChat(page)
  expect(clamped.card.right).toBeCloseTo(clamped.chat.right, 0)
  expect(Math.abs(clamped.card.bottom - clamped.thread.bottom)).toBeLessThanOrEqual(1)
  expect(packedBlocks(clamped).reasons, 'parked at the bottom').toEqual([])
  await expect(deck).not.toHaveAttribute('data-dragging')
  expect(await geometry()).toEqual(baseline)
  const restored = await card.boundingBox()
  for (const [index, testId] of [[1, 'preview-card-collapsed'], [2, 'preview-card-reopen']]) {
    await card.hover()
    await card.locator('.preview-card-actions button').nth(index).click()
    await expect(card).toHaveCount(0)
    expect(await geometry()).toEqual(baseline)
    await page.getByTestId(testId).click()
    await expect(card).toBeVisible()
    await settle()
    expect(await card.boundingBox()).toEqual(restored)
    expect(await geometry()).toEqual(baseline)
    expect(packedBlocks(await measureChat(page)).reasons).toEqual([])
  }
  await begin()
  await page.mouse.move(restored.x + 80, restored.y + 30)
  const held = await relative()
  await sendEvents(app, [{ type: 'desktop:preview', frames: [{ id: 'second', lane, title: 'Second card', at: Date.now(), data: `data:image/png;base64,${frame.data}`, captureState: 'ready' }] }])
  await expect(card).toHaveAttribute('data-source', 'app')
  await settle()
  await expect(deck).toHaveAttribute('data-dragging', '')
  expect(await relative()).toEqual(held)
  await page.mouse.move(restored.x + 100, restored.y + 50)
  expect((await relative()).x).toBeCloseTo(held.x + 20, 0)
  await page.mouse.up()
  await deck.focus()
  await page.keyboard.press('ArrowRight')
  await expect(card).toHaveAttribute('data-source', 'web')
  await page.keyboard.press('ArrowLeft')
  await expect(card).toHaveAttribute('data-source', 'app')
  await page.keyboard.press('ArrowLeft')
  await expect(card).toHaveAttribute('data-source', 'web')
  await settle()
  expect(await deck.locator('[data-position="0"]').evaluate(node => getComputedStyle(node).animationName)).toBe('preview-deck-forward')
  expect(await geometry()).toEqual(baseline)
  const chosen = await relative()
  for (const width of [1100, 1600, 1400]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    await expect.poll(async () => packedBlocks(await measureChat(page)).reasons).toEqual([])
    if (width === 1100) await expect.poll(async () => (await relative()).x).toBeLessThan(chosen.x)
  }
  await expect.poll(relative).toEqual(chosen)
  const appFrames = ids => ({ type: 'desktop:preview', frames: ids.map(id => ({ id, lane, title: id, at: Date.now(), data: `data:image/png;base64,${frame.data}`, captureState: 'ready' })) })
  const stackInside = () => deck.evaluate(node => {
    const chat = node.parentElement.getBoundingClientRect()
    return [...node.querySelectorAll('.preview-deck-card')].every(card => {
      const box = card.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + 5, box.top + 5)
      return box.left >= chat.left - 1 && box.top >= chat.top - 1
        && box.right <= chat.right + 1 && box.bottom <= chat.bottom + 1 && card.contains(hit)
    })
  })
  let savedLane
  for (const [index, x] of [[0, 600], [1, 0]]) {
    await begin()
    await page.mouse.move(x, 0, { steps: 10 })
    await page.mouse.up()
    savedLane = await relative()
    await sendEvents(app, [appFrames(['second', ...['third', 'fourth'].slice(0, index + 1)])])
    await expect(deck.locator('.preview-deck-card')).toHaveCount(index + 3)
    await settle()
    await expect.poll(stackInside).toBe(true)
    expect((await relative()).y).toBeCloseTo((index + 2) * 30, 0)
  }
  await sendEvents(app, [appFrames([])])
  await expect(deck.locator('.preview-deck-card')).toHaveCount(1)
  await expect.poll(relative).toEqual(savedLane)
  await page.locator('.bots-row', { hasText: other.name }).click()
  await showWebFrame(app, { lane: `bot-${other.id}`, url: URL, frame })
  await expect(card).toBeVisible()
  await settle()
  expect(await deck.evaluate(node => node.style.left)).toBe('')
  await dragAcross(page, card, async () => expect(packedBlocks(await measureChat(page)).reasons).toEqual([]))
  const otherPosition = await relative()
  await page.locator('.bots-row', { hasText: BOT }).click()
  await expect(card).toBeVisible()
  await settle()
  expect(await relative()).toEqual(savedLane)
  await expect.poll(stackInside).toBe(true)
  await page.locator('.bots-row', { hasText: other.name }).click()
  await expect(card).toBeVisible()
  await settle()
  expect(await relative()).toEqual(otherPosition)
  await page.locator('.bots-row', { hasText: BOT }).click()
  await expect(card).toBeVisible()
  await settle()
  await sendEvents(app, [appFrames(['second', 'third', 'fourth'])])
  await expect(deck.locator('.preview-deck-card')).toHaveCount(4)
  const tall = await page.evaluate(() => window.innerHeight)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 600))
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(650)
  await settle()
  const park = async () => {
    await begin()
    await page.mouse.move(2000, 1500, { steps: 10 })
    await page.mouse.up()
    return measureChat(page)
  }
  const parked = await park()
  expect(packedBlocks(parked).reasons, 'parked at the bottom of a short window').toEqual([])
  expect(Math.abs(parked.card.bottom - parked.thread.bottom)).toBeLessThanOrEqual(1)
  await begin()
  await expect(deck).toHaveAttribute('data-dragging', '')
  await page.mouse.move(parked.card.left, parked.card.top, { steps: 6 })
  await page.mouse.up()
  expect((await measureChat(page)).card.top).toBeLessThan(parked.card.top - 20)
  await park()
  await page.getByTestId('bots-input').fill('one\ntwo\nthree\nfour')
  await expect.poll(async () => (await measureChat(page)).thread.bottom).toBeLessThan(parked.thread.bottom - 40)
  await expect.poll(async () => packedBlocks(await measureChat(page)).reasons, 'composer grew under a parked card').toEqual([])
  await page.getByTestId('bots-input').fill('')
  await expect.poll(async () => (await measureChat(page)).card.top).toBeCloseTo(parked.card.top, 0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(tall)
  await expect.poll(async () => packedBlocks(await measureChat(page)).reasons).toEqual([])
  for (let index = 0; index < 4 && await card.getAttribute('data-source') !== 'web'; index++) {
    await deck.focus()
    await page.keyboard.press('ArrowRight')
  }
  await expect(card).toHaveAttribute('data-source', 'web')
  await card.hover()
  await card.locator('.preview-card-actions button').first().click()
  await expect(page.getByTestId('live-address')).toBeVisible()

  const point = ({ x, y }) => `${Math.round(x)},${Math.round(y)}`
  return {
    ok: true,
    evidence: `agent:frame ${frame.width}x${frame.height} png painted preview-card for ${lane} with no web pane; ${describeBlocks(before)}; `
      + `drag ${point(drag.from)} to ${point(drag.to)}: moved and clamped; tab/blur/cancel, reopen position, incoming-frame drag, resize anchors, stacked depth bounds, lane positions, popover dismissal, chosen spot after shrink and stack changes, composer floor at 600px and under a growing draft, and native animations verified; after: ${describeBlocks(after)}`,
  }
}
