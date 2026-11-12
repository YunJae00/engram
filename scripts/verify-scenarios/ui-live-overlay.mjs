/* global document, window, getComputedStyle */
import { createBot, appendBotTurn } from '../../packages/core/src/index.ts'
import { armPointer, constrainFloor, deckAt, deckDriver, describeBlocks, flowGeometry, expectPacked, measureChat, packedBlocks, pollPacked, resizeWindow, settle } from './lib/chat-layout.mjs'
import { pngFrame, sendAppFrames, sendUnavailableFrame, showWebFrame, solidFrame } from './lib/frame-fixture.mjs'

const BOT = 'Live overlay'
const URL = 'https://example.test/live'
export async function run(page, { app, paths, expect, openActivity }) {
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  const bot = await createBot(paths, { name: BOT, purpose: '' })
  const other = await createBot(paths, { name: 'Other overlay lane', purpose: '' })
  const fresh = await createBot(paths, { name: 'Fresh app lane', purpose: '' })
  for (const role of ['user', 'assistant']) await appendBotTurn(paths, bot.id, { role, text: `Overlay geometry ${role}`, at: new Date().toISOString() })
  // A window never shown paints once a second under Xvfb; shown inactive it runs at full rate without taking focus.
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1400, 900); win.showInactive() })
  const arm = async () => { await page.reload(); await armPointer(page); await openActivity(page, 'bots') }
  await arm()
  const open = id => page.getByTestId(`bot-${id}`).click()
  await open(bot.id)
  const lane = `bot-${bot.id}`
  const frame = pngFrame({ width: 1280, height: 800 })
  const small = solidFrame([40, 160, 90])
  const card = page.getByTestId('preview-card')
  const { deck, press, pointerId, hold, slide, spot, synthetic, dragTo, dragBy, escapeDrag, expectAt, expectIdle, expectHeld } = deckDriver(page, expect)
  const count = async n => { await expect(deck.locator('.preview-deck-card')).toHaveCount(n); await settle(page) }
  const visible = async () => { await expect(card).toBeVisible(); await settle(page) }
  let flow
  // Bubbles may reflow sideways to clear the card; the thread box, the composer and every bubble's top and height must not move.
  const vertical = geometry => [geometry[0], geometry[1], ...geometry.slice(2).map(([, y, , height]) => [y, height])]
  const expectFlow = async label => expect(vertical(await flowGeometry(page)), label).toEqual(vertical(flow))

  // Live rendering: a real PNG paints into the card without a web pane, docked at the top right over a full-height thread until dragged.
  await settle(page)
  flow = await flowGeometry(page)
  const bare = await page.evaluate(() => { const box = s => document.querySelector(s).getBoundingClientRect(); return { chat: box('.bots-chat').top, top: box('.bots-thread').top, height: box('.bots-thread').height } })
  expect(bare.top - bare.chat, 'no empty band above the thread').toBeLessThanOrEqual(60)
  await showWebFrame(app, { lane, url: URL, frame })
  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })
  await expect(card.locator('canvas')).toHaveAttribute('data-format', 'png')
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  await expect(card.locator('.preview-card-label')).toContainText('example.test')
  expect(await card.locator('canvas').evaluate(canvas => [canvas.width, canvas.height])).toEqual([frame.width, frame.height])
  expect(await card.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(256, 320, 1, 1).data])).toEqual([220, 60, 60, 255])
  expect(await card.evaluate(node => getComputedStyle(node).animationName)).toBe('preview-card-in')
  await settle(page)
  await expectFlow('the first card docks without moving the thread')
  const anchored = await deckAt(page)
  expect([anchored.left, anchored.floating]).toEqual(['', false])
  const before = await measureChat(page)
  expect(packedBlocks(before).reasons, 'docked before any drag').toEqual([])
  expect([Math.abs(before.thread.top - bare.top) <= 4, before.thread.height >= bare.height - 4], 'the thread keeps its full height').toEqual([true, true])
  expect([before.card.top - before.chat.top <= 20, Math.abs(before.card.right - before.chat.right) <= 40], 'docked at the chat top right').toEqual([true, true])

  // Untouched bounds: a four-card stack stays inside the chat and above the thread floor through resizes and a growing draft.
  await sendAppFrames(app, lane, ['second', 'third', 'fourth'], small)
  await count(4)
  for (const [width, height] of [[1000, 560], [1400, 600], [1400, 900]]) {
    await resizeWindow(app, page, expect, width, height)
    await pollPacked(page, expect, `untouched stack at ${width}x${height}`)
  }
  await page.getByTestId('bots-input').fill('one\ntwo\nthree\nfour')
  await expect.poll(async () => (await measureChat(page)).thread.bottom).toBeLessThan(before.thread.bottom - 40)
  await pollPacked(page, expect, 'untouched stack under a four-line draft')
  await page.getByTestId('bots-input').fill('')
  await expect.poll(async () => (await deckAt(page)).left).toBe('')
  expect((await deckAt(page)).right).toBe(anchored.right)
  await sendAppFrames(app, lane, [], small)
  await count(1)
  await expectFlow('after the stack cleared')

  // The CSS right anchor survives tab switches and window widths while nothing has been dragged.
  await openActivity(page, 'list')
  await expect(card).toBeHidden()
  await openActivity(page, 'bots')
  await visible()
  await expectAt(anchored, 'after a tab switch')
  for (const width of [1100, 1600, 1400]) {
    await resizeWindow(app, page, expect, width, 900)
    await expect.poll(async () => (await deckAt(page)).right).toBe(anchored.right)
    expect((await deckAt(page)).left).toBe('')
  }
  await expectFlow('after width changes')

  // A press on the card dismisses open popovers without starting a placement.
  for (const [trigger, menu] of [[page.getByTestId('workspace-switcher'), 'workspace-menu'], [page.locator('.bots-chat').getByTestId('model-picker'), 'model-picker-menu']]) {
    await trigger.click()
    await expect(page.getByTestId(menu)).toBeVisible()
    await expectPacked(page, expect, `${menu} open`)
    await hold()
    await page.mouse.up()
    await expect(page.getByTestId(menu)).toHaveCount(0)
    expect((await deckAt(page)).left).toBe('')
  }

  // The real drag lifts the card off the fixed slot; the thread never shifts, neither at the lift nor while the card moves.
  await hold()
  await slide(-before.card.width * 0.3, 0, 6)
  await settle(page)
  expect((await deckAt(page)).floating).toBe(true)
  await expectFlow('the drag lifts the card without moving the thread')
  await slide(-before.card.width, before.card.height, 12)
  await expectFlow('late in the drag')
  await page.mouse.up()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '')
  await expect(page.getByTestId('bots-input')).toBeVisible()
  const after = await measureChat(page)
  expect(packedBlocks(after).reasons, 'after the drag').toEqual([])
  expect(Math.abs(after.card.left - (before.card.left - before.card.width))).toBeLessThan(2)
  expect(Math.abs(after.card.top - (before.card.top + before.card.height))).toBeLessThan(2)
  await expectFlow('after the drag')
  expect(await page.evaluate(() => document.getSelection().toString())).toBe('')
  const origin = await deckAt(page)
  await page.mouse.move(500, 500)
  await expectAt(origin, 'pointer moved without a press')
  await expectIdle()

  // Every cancellation discards the provisional point and returns to the committed one.
  for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'tab']) {
    await hold()
    await slide(80, 30)
    await expectHeld()
    if (cancellation === 'tab') {
      await page.getByTestId('workspace-switcher').evaluate(node => node.click())
      await page.getByTestId('activity-list').evaluate(node => node.click())
      await expect(card).toBeHidden()
      await openActivity(page, 'bots')
      await visible()
    }
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else if (cancellation === 'Escape') await page.keyboard.press('Escape')
    else if (cancellation === 'lostpointercapture') await deck.evaluate((node, id) => node.releasePointerCapture(id), await pointerId())
    else await synthetic(cancellation, await pointerId())
    await page.mouse.up()
    await expectAt(origin, `after ${cancellation}`)
    await expectIdle()
    await expectFlow(`after ${cancellation}`)
  }

  // A second pointer and a refused capture leave the placement alone; a press without movement commits nothing.
  await hold()
  await slide(40, 40)
  const held = await deckAt(page)
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) await synthetic(type, await pointerId() + 1)
  await expectHeld()
  await expectAt(held, 'after a second pointer')
  await slide(50, 50)
  expect((await deckAt(page)).x).toBe(held.x + 10)
  await page.mouse.up()
  const committed = await deckAt(page)
  await deck.evaluate(node => { node.setPointerCapture = () => { throw new Error('capture refused') } })
  try {
    await hold()
    await slide(90, 90)
    await expectAt(committed, 'while capture is refused')
    await expectIdle()
    await page.mouse.up()
  } finally { await deck.evaluate(node => { delete node.setPointerCapture }) }
  await hold()
  await expectHeld()
  await page.mouse.up()
  await expectAt(committed, 'after a press without movement')

  // Clamps: the card stops at the chat edges and never runs below the thread onto the composer.
  expect(spot(await dragTo(0, 0))).toEqual({ x: 0, y: 0 })
  await dragTo(2000, 1500)
  const clamped = await measureChat(page)
  expect(clamped.card.right).toBeCloseTo(clamped.chat.right, 0)
  expect(Math.abs(clamped.card.bottom - clamped.thread.bottom)).toBeLessThanOrEqual(1)
  expect(packedBlocks(clamped).reasons, 'parked at the bottom').toEqual([])
  await expectIdle()
  await expectFlow('parked at the bottom')
  const restored = await deckAt(page)
  for (const [index, testId] of [[1, 'preview-card-collapsed'], [2, 'preview-card-reopen']]) {
    await card.hover()
    await card.locator('.preview-card-actions button').nth(index).click()
    await expect(card).toHaveCount(0)
    expect(await page.getByTestId(testId).evaluate(node => node.getBoundingClientRect().bottom - Math.min(document.querySelector('.bots-thread').getBoundingClientRect().bottom, document.querySelector('.bots-chat > .bots-write').getBoundingClientRect().top)), `${testId} above the thread floor`).toBeLessThanOrEqual(1)
    await page.getByTestId(testId).click()
    await visible()
    await expectAt(restored, `after ${testId}`)
    await expectFlow(`after ${testId}`)
    await expectPacked(page, expect, `after ${testId}`)
  }

  // Incoming frames while held: the deck node, capture and segment survive a new front card and replaced image data.
  await hold()
  await slide(-80, -30)
  await deck.evaluate(node => { globalThis.liveDeck = node })
  const heldAt = await deckAt(page)
  await sendAppFrames(app, lane, ['second'], small)
  await expect(card).toHaveAttribute('data-source', 'app')
  await settle(page)
  await expectHeld()
  expect(await deck.evaluate(node => node === globalThis.liveDeck)).toBe(true)
  await expectAt(heldAt, 'after an incoming front frame')
  const replaced = solidFrame([200, 30, 120])
  await sendAppFrames(app, lane, ['second'], replaced)
  await expect(card.locator('img')).toHaveAttribute('src', `data:image/png;base64,${replaced.data}`)
  await expectHeld()
  await slide(-100, -50)
  expect((await deckAt(page)).x).toBe(heldAt.x - 20)
  await page.mouse.up()
  await deck.focus()
  for (const [key, source] of [['ArrowRight', 'web'], ['ArrowLeft', 'app'], ['ArrowLeft', 'web']]) {
    await page.keyboard.press(key)
    await expect(card).toHaveAttribute('data-source', source)
  }
  await settle(page)
  expect(await deck.locator('[data-position="0"]').evaluate(node => getComputedStyle(node).animationName)).toBe('preview-deck-forward')
  await expectFlow('after cycling cards')

  // A chosen spot is clamped by a narrower window and comes back when the width returns.
  const chosen = await dragTo(2000, press.y)
  for (const width of [1100, 1600, 1400]) {
    await resizeWindow(app, page, expect, width, 900)
    await pollPacked(page, expect, `chosen spot at ${width}`)
    if (width === 1100) await expect.poll(async () => (await deckAt(page)).x).toBeLessThan(chosen.x)
  }
  await expect.poll(async () => spot(await deckAt(page))).toEqual(spot(chosen))

  // Stack growth pushes a parked card inward; mid-drag growth and resizes clamp, rebase the segment and keep capture.
  await dragTo(600, 0)
  await sendAppFrames(app, lane, ['second', 'third'], small)
  await count(3)
  await pollPacked(page, expect, 'stack of 3')
  expect((await deckAt(page)).y).toBe(60)
  await dragTo(0, 0)
  await expectAt({ x: 60, y: 60 }, 'parked at the corner of a stack of 3')
  await hold()
  await slide(80, 30, 4)
  await slide(0, 0, 4)
  await sendAppFrames(app, lane, ['second', 'third', 'fourth'], small)
  await count(4)
  await expectHeld()
  await expectAt({ x: 90, y: 90 }, 'held at the corner of a stack of 4')
  await slide(1, 1)
  await expectAt({ x: 91, y: 91 }, 'one pixel away from the corner')
  await resizeWindow(app, page, expect, 1100, 900)
  await expectHeld()
  await expectAt({ x: 91, y: 91 }, 'held through a resize')
  await slide(0, 0)
  await expectAt({ x: 90, y: 90 }, 'back at the corner after the resize')
  await page.mouse.up()
  await resizeWindow(app, page, expect, 1400, 900)
  await expect.poll(async () => spot(await deckAt(page))).toEqual({ x: 90, y: 90 })
  await pollPacked(page, expect, 'stack of 4 at the corner')
  await sendAppFrames(app, lane, [], small)
  await count(1)
  await expect.poll(async () => spot(await deckAt(page))).toEqual({ x: 90, y: 90 })
  await expectFlow('after the stack cleared again')
  const savedLane = await deckAt(page)

  // Lanes keep independent spots; a provisional drag dropped by a lane switch leaves both untouched.
  await open(other.id)
  await showWebFrame(app, { lane: `bot-${other.id}`, url: URL, frame })
  await visible()
  expect((await deckAt(page)).left).toBe('')
  const otherPosition = await dragBy(-200, 120)
  expect(otherPosition.left).not.toBe('')
  await open(bot.id)
  await visible()
  await expectAt(savedLane, 'back on the first lane')
  await hold()
  await slide(60, 60)
  await expectHeld()
  await page.getByTestId(`bot-${other.id}`).evaluate(node => node.click())
  await page.mouse.up()
  await visible()
  await expectAt(otherPosition, 'other lane after a dropped drag')
  await expectIdle()
  await open(bot.id)
  await visible()
  await expectAt(savedLane, 'first lane after a dropped drag')
  await expectIdle()
  await hold()
  await expectHeld()
  await page.mouse.up()

  // Short window: the composer floor holds a parked card and a growing draft lifts it.
  await sendAppFrames(app, lane, ['second', 'third', 'fourth'], small)
  await count(4)
  await resizeWindow(app, page, expect, 1400, 600)
  await settle(page)
  await dragTo(2000, 1500)
  const parked = await measureChat(page)
  expect(packedBlocks(parked).reasons, 'parked at the bottom of a short window').toEqual([])
  expect(Math.abs(parked.card.bottom - parked.thread.bottom)).toBeLessThanOrEqual(1)
  await hold()
  await expectHeld()
  await page.mouse.move(parked.card.left, parked.card.top, { steps: 6 })
  await page.mouse.up()
  expect((await measureChat(page)).card.top).toBeLessThan(parked.card.top - 20)
  await dragTo(2000, 1500)
  await page.getByTestId('bots-input').fill('one\ntwo\nthree\nfour')
  await expect.poll(async () => (await measureChat(page)).thread.bottom).toBeLessThan(parked.thread.bottom - 40)
  await pollPacked(page, expect, 'composer grew under a parked card')
  await page.getByTestId('bots-input').fill('')
  await expect.poll(async () => (await measureChat(page)).card.top).toBeCloseTo(parked.card.top, 0)
  await resizeWindow(app, page, expect, 1400, 900)
  await pollPacked(page, expect, 'tall again')

  // A fresh app-only lane: six frames, fit limits, suspension, cancellation before a first drag, empty frames and remounts.
  const freshLane = `bot-${fresh.id}`; await open(fresh.id)
  await sendAppFrames(app, freshLane, ['a', 'b', 'c', 'd', 'e', 'f'], small)
  await count(4)
  const docked = await deckAt(page)
  expect([docked.depth, docked.left, docked.floating]).toEqual([3, '', false])
  const seen = new Set([docked.front])
  for (let step = 0; step < 5; step++) {
    await deck.focus()
    await page.keyboard.press('ArrowRight')
    await settle(page)
    seen.add((await deckAt(page)).front)
    await expectPacked(page, expect, `front card ${step + 1}`)
  }
  expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  const lifted = async () => { await expectHeld(); expect((await deckAt(page)).floating).toBe(true) }
  expect(await escapeDrag(-80, 40, lifted)).toMatchObject({ left: '', floating: false })
  await resizeWindow(app, page, expect, 1100, 900)
  await expect.poll(async () => (await deckAt(page)).right).toBe(docked.right)
  await resizeWindow(app, page, expect, 1400, 900)
  const freshSpot = await dragBy(-120, 60)
  expect([freshSpot.left !== '', freshSpot.floating, freshSpot.spacing]).toEqual([true, true, 30])
  try {
    expect(Math.abs(await constrainFloor(page, 100) - 100), 'thread floor pinned at 100px').toBeLessThanOrEqual(1)
    await expect.poll(async () => (await deckAt(page)).spacing).toBeLessThan(30)
    const fitted = await deckAt(page)
    expect(fitted.height).toBeLessThan(freshSpot.height)
    expect(fitted.height).toBeGreaterThanOrEqual(44)
    await pollPacked(page, expect, 'fitted to a 100px floor')
    await card.hover()
    await card.locator('.preview-card-actions button').nth(0).click()
    await page.getByTestId('preview-card-collapsed').click()
    await visible()
    await pollPacked(page, expect, 'fitted again after a collapse')
    const composerFitted = (await flowGeometry(page))[1].slice(2, 4)
    await page.evaluate(() => { document.querySelector('.bots-thread').style.padding = '0' })
    expect(await constrainFloor(page, 30), 'thread floor below a 44px card').toBeLessThan(44)
    await expect.poll(async () => (await deckAt(page)).suspended).toBe(true)
    await expect(card).toBeHidden()
    const corner = await page.evaluate(() => { const chat = document.querySelector('.bots-chat').getBoundingClientRect(); return { x: chat.right - 40, y: chat.top + 10 } })
    await page.mouse.move(corner.x, corner.y)
    await page.mouse.down()
    await expectIdle()
    await page.mouse.up()
    expect((await flowGeometry(page))[1].slice(2, 4)).toEqual(composerFitted)
  } finally { await page.evaluate(() => { document.querySelector('.bots-thread').style.padding = '' }); await constrainFloor(page, null) }
  await expect.poll(async () => { const now = await deckAt(page); return [now.suspended, now.spacing, now.height, now.x, now.y] }).toEqual([false, 30, freshSpot.height, freshSpot.x, freshSpot.y])
  await escapeDrag(-60, -30)
  await expectAt(freshSpot, 'escape after a committed drag')
  await sendAppFrames(app, freshLane, [], small)
  await expect(deck).toHaveCount(0)
  await sendAppFrames(app, freshLane, ['a', 'b'], small)
  await visible()
  await expectAt(freshSpot, 'after the deck remounted')
  await hold()
  await slide(-60, -30)
  await expectHeld()
  await sendAppFrames(app, freshLane, [], small)
  await expect(deck).toHaveCount(0)
  await page.mouse.up()
  await sendAppFrames(app, freshLane, ['a'], small)
  await visible()
  await expectAt(freshSpot, 'after clearing while held')
  await sendUnavailableFrame(app, freshLane, 'a')
  await expect(card.locator('.preview-card-state')).toContainText('Screen Recording permission required')
  await expectPacked(page, expect, 'unavailable frame')
  expect(spot(await dragBy(30, 30))).toEqual({ x: freshSpot.x + 30, y: freshSpot.y + 30 })
  await sendAppFrames(app, freshLane, ['a'], small)
  await expect(card.locator('img')).toBeVisible()
  await expect(card.locator('.preview-card-state')).toHaveCount(0)

  // Opening the browser beside the chat still works from the overlay card.
  await open(bot.id)
  for (let index = 0; index < 4 && await card.getAttribute('data-source') !== 'web'; index++) { await deck.focus(); await page.keyboard.press('ArrowRight') }
  await expect(card).toHaveAttribute('data-source', 'web')
  await card.hover()
  await card.locator('.preview-card-actions button').first().click()
  await expect(page.getByTestId('live-address')).toBeVisible()

  // Restart: lane positions are renderer memory, so a reload starts from the default anchor with a working drag.
  await arm()
  await open(fresh.id)
  await sendAppFrames(app, freshLane, ['a', 'b'], small)
  await visible()
  const reset = await deckAt(page)
  expect([reset.left, reset.dragging, reset.floating, reset.right]).toEqual(['', false, false, docked.right])
  expect(spot(await dragBy(-100, 50))).toEqual({ x: reset.x - 100, y: reset.y + 50 })
  await expectIdle()
  expect(errors).toEqual([])
  return {
    ok: true,
    evidence: `agent:frame ${frame.width}x${frame.height} png painted preview-card for ${lane} with no web pane; docked: ${describeBlocks(before)}; floating after the drag: ${describeBlocks(after)}; `
      + `untouched decks docked top right while the thread keeps its full height, a thread that keeps its place as cards mount, clear and lift, four-card bounds at 1000x560/1400x600 and under a draft, a stable thread once the card floats, right anchor through tab and widths, popover dismissal, escape/cancel/lostcapture/blur/tab cancellations, `
      + `second pointer and refused capture ignored, corner and composer-floor clamps, reopen position, held drag through incoming frames and a replaced image, depth growth and resize with 1px rebase, lane spots and a dropped lane-switch drag, `
      + `600px floor under a growing draft, fit to a 100px floor, suspension below 44px, six frames cycling four cards, empty-frame remounts, unavailable frame recovery, browser open and a reload back to the anchor verified; last press at ${Math.round(press.x)},${Math.round(press.y)}`,
  }
}
