/* global document, window, innerWidth, innerHeight, PointerEvent */

export function settle(page) {
  return page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
}

// The overlay deck in chat-local layout coordinates, read from offsets so entrance animations do not move the answer.
export function deckAt(page) {
  return page.evaluate(() => {
    const deck = document.querySelector('.preview-deck')
    if (!deck) return null
    const chat = deck.parentElement
    return {
      x: deck.offsetLeft, y: deck.offsetTop, width: deck.offsetWidth, height: deck.offsetHeight,
      right: chat.clientWidth - deck.offsetLeft - deck.offsetWidth, left: deck.style.left, top: deck.style.top,
      dragging: deck.hasAttribute('data-dragging'), suspended: deck.hasAttribute('data-suspended'), floating: deck.hasAttribute('data-floating'),
      spacing: parseFloat(deck.style.getPropertyValue('--live-fit-space')), depth: Number(deck.style.getPropertyValue('--deck-depth')),
      cards: deck.querySelectorAll('.preview-deck-card').length, front: deck.querySelector('[data-position="0"]')?.dataset.frame,
    }
  })
}

// Thread, composer and bubble rectangles plus scroll state: moving or updating a placed deck must leave all of them where they were.
export function flowGeometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector)
      const box = node.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height, node.scrollHeight, node.scrollTop]
    }
    return [rect('.bots-thread'), rect('.bots-chat textarea'), ...[...document.querySelectorAll('.bubble-msg')].slice(0, 2).map(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height] })]
  })
}

export function measureChat(page) {
  return page.evaluate(() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const chat = document.querySelector('.bots-chat')
    const main = document.querySelector('.bots-main')
    const deck = document.querySelector('.preview-deck')
    const card = document.querySelector('.preview-card')
    const thread = document.querySelector('.bots-thread')
    const composer = document.querySelector('.bots-chat > .bots-write')
    const input = document.querySelector('.bots-chat textarea')
    if (!chat || !main || !deck || !card || !thread || !composer || !input) return null
    const box = card.getBoundingClientRect()
    const middle = (box.left + box.right) / 2
    const spacing = parseFloat(deck.style.getPropertyValue('--live-fit-space')) || 0
    const stack = [...deck.querySelectorAll('.preview-deck-card')].map(node => {
      const own = node.getBoundingClientRect()
      const position = Number(node.dataset.position)
      const probe = [own.left + own.width / 2, own.top + Math.min(5, spacing / 2)]
      return { ...rect(node), position, exposed: position === 0 || spacing < 2 || node.contains(document.elementFromPoint(...probe)) }
    })
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stack, main: rect(main), chat: rect(chat), card: rect(card), thread: rect(thread), composer: rect(composer), input: rect(input),
      cardOnTop: [(box.top + box.bottom) / 2, box.top + 5, box.bottom - 5].every(y => card.contains(document.elementFromPoint(middle, y))),
      pane: document.querySelector('.web-pane') !== null, floating: deck.hasAttribute('data-floating'),
    }
  })
}

const inside = (box, outer, slack = 1) => box.left >= outer.left - slack && box.right <= outer.right + slack && box.top >= outer.top - slack && box.bottom <= outer.bottom + slack

export function packedBlocks(measure) {
  if (!measure) return { ok: false, reasons: ['chat, deck, card, thread or composer is missing'] }
  const { viewport, main, chat, card, thread, composer, stack, input, cardOnTop, pane, floating } = measure
  const reasons = []
  const show = box => `${Math.round(box.left)},${Math.round(box.top)}-${Math.round(box.right)},${Math.round(box.bottom)}`
  if (card.right > viewport.width + 1 || card.bottom > viewport.height + 1) reasons.push(`card ${show(card)} leaves the window`)
  if (!inside(card, chat)) reasons.push(`card ${show(card)} leaves the chat ${show(chat)}`)
  for (const box of stack) {
    if (!inside(box, chat)) reasons.push(`stack card ${box.position} ${show(box)} leaves the chat ${show(chat)}`)
    if (box.bottom > thread.bottom + 1) reasons.push(`stack card ${box.position} ${show(box)} runs below the thread floor ${Math.round(thread.bottom)}`)
    if (!box.exposed) reasons.push(`stack card ${box.position} has no exposed corner`)
  }
  if (card.bottom > thread.bottom + 1 || card.bottom > composer.top) reasons.push(`card ${show(card)} runs past the thread onto the composer`)
  if (!floating && card.bottom > thread.top + 1) reasons.push(`docked card ${show(card)} covers the thread top ${Math.round(thread.top)}`)
  if (!inside(input, chat)) reasons.push('composer leaves the chat')
  if (Math.abs(chat.width - main.width) >= 2) reasons.push('chat is narrowed beside the card')
  if (pane) reasons.push('a web pane is open beside the chat')
  if (!cardOnTop) reasons.push('something paints over the card')
  return { ok: reasons.length === 0, reasons }
}

export async function expectPacked(page, expect, label) {
  expect(packedBlocks(await measureChat(page)).reasons, label).toEqual([])
}

export function pollPacked(page, expect, label) {
  return expect.poll(async () => packedBlocks(await measureChat(page)).reasons, label).toEqual([])
}

export async function resizeWindow(app, page, expect, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height])
}

// Pins the thread floor below the chat top at the given height by constraining the chat, so fit limits can be forced on any window.
export function constrainFloor(page, floor) {
  return page.evaluate((floor) => {
    const chat = document.querySelector('.bots-chat')
    const thread = chat.querySelector(':scope > .bots-thread')
    if (floor === null) { chat.style.maxHeight = ''; return }
    const rest = chat.clientHeight - thread.offsetTop - thread.offsetHeight
    chat.style.maxHeight = `${rest + floor}px`
  }, floor)
}

export function describeBlocks({ card, chat, thread }) {
  const box = (one) => `${Math.round(one.left)},${Math.round(one.top)} ${Math.round(one.width)}x${Math.round(one.height)}`
  return `card ${box(card)} in chat ${box(chat)} with thread at y=${Math.round(thread.top)}`
}

// Real mouse drags on the overlay deck, with the last trusted pointer id recorded by armPointer for capture checks.
export function armPointer(page) {
  return page.evaluate(() => document.addEventListener('pointerdown', event => { if (event.isTrusted) globalThis.livePointer = event.pointerId }, true))
}

export function deckDriver(page, expect) {
  const deck = page.getByTestId('preview-deck')
  const press = { x: 0, y: 0 }
  const pointerId = () => page.evaluate(() => globalThis.livePointer)
  const captured = async () => deck.evaluate((node, id) => node.hasPointerCapture(id), await pointerId())
  const hold = async () => {
    const box = await deck.boundingBox()
    press.x = box.x + box.width / 2
    press.y = box.y + box.height / 2
    await page.mouse.move(press.x, press.y)
    await page.mouse.down()
  }
  const slide = (dx, dy, steps = 1) => page.mouse.move(press.x + dx, press.y + dy, { steps })
  const spot = ({ x, y }) => ({ x, y })
  return {
    deck, press, pointerId, captured, hold, slide, spot,
    synthetic: (type, id) => deck.evaluate((node, init) => node.dispatchEvent(new PointerEvent(init.type, { pointerId: init.id, bubbles: true, isPrimary: false })), { type, id }),
    dragTo: async (x, y) => { await hold(); await page.mouse.move(x, y, { steps: 8 }); await page.mouse.up(); return deckAt(page) },
    dragBy: async (dx, dy) => { await hold(); await slide(dx, dy, 8); await page.mouse.up(); return deckAt(page) },
    escapeDrag: async (dx, dy, during = async () => {}) => { await hold(); await slide(dx, dy); await during(); await page.keyboard.press('Escape'); await page.mouse.up(); return deckAt(page) },
    expectAt: async (expected, label) => { const now = await deckAt(page); expect(spot(now), label).toEqual(spot(expected)); return now },
    expectIdle: async () => { expect((await deckAt(page)).dragging).toBe(false); expect(await captured()).toBe(false) },
    expectHeld: async () => { expect((await deckAt(page)).dragging).toBe(true); expect(await captured()).toBe(true) },
  }
}
