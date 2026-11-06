/* global document, innerWidth, innerHeight */

export function measureChat(page) {
  return page.evaluate(() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const chat = document.querySelector('.bots-chat')
    const main = document.querySelector('.bots-main')
    const card = document.querySelector('.preview-card')
    const thread = document.querySelector('.bots-thread')
    const composer = document.querySelector('.bots-chat > .bots-write')
    const input = document.querySelector('.bots-chat textarea')
    if (!chat || !main || !card || !thread || !composer || !input) return null
    const box = card.getBoundingClientRect()
    const middle = (box.left + box.right) / 2
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stack: [...document.querySelectorAll('.preview-deck-card')].map(rect),
      main: rect(main), chat: rect(chat), card: rect(card), thread: rect(thread), composer: rect(composer), input: rect(input),
      cardOnTop: [(box.top + box.bottom) / 2, box.top + 5, box.bottom - 5].every(y => card.contains(document.elementFromPoint(middle, y))),
      pane: document.querySelector('.web-pane') !== null,
      shift: document.querySelector('.preview-deck')?.style.translate ?? '',
    }
  })
}

const inside = (box, outer, slack = 1) => box.left >= outer.left - slack && box.right <= outer.right + slack && box.top >= outer.top - slack && box.bottom <= outer.bottom + slack

export function packedBlocks(measure, { slotted = false } = {}) {
  if (!measure) return { ok: false, reasons: ['chat, card, thread or composer is missing'] }
  const { viewport, main, chat, card, thread, composer, stack, input, cardOnTop, pane, shift } = measure
  const reasons = []
  if (slotted && shift) reasons.push(`an untouched card is shifted by ${shift}`)
  if (slotted && stack.some(box => box.bottom > thread.top + 1)) reasons.push('an untouched card overlaps the thread')
  if (card.right > viewport.width + 1 || card.bottom > viewport.height + 1) reasons.push('card leaves the window')
  if (!inside(card, chat)) reasons.push('card leaves the chat')

  if (stack.some(box => !inside(box, chat))) reasons.push('stack leaves the chat')
  if (stack.some(box => box.bottom > thread.bottom + 1)) reasons.push('stack runs past the thread onto the composer')
  if (card.bottom > thread.bottom + 1 || card.bottom > composer.top) reasons.push('card runs past the thread onto the composer')
  if (!inside(input, chat)) reasons.push('composer leaves the chat')
  if (Math.abs(chat.width - main.width) >= 2) reasons.push('chat is narrowed beside the card')
  if (pane) reasons.push('a web pane is open beside the chat')
  if (!cardOnTop) reasons.push('something paints over the card')
  return { ok: reasons.length === 0, reasons }
}

export function describeBlocks({ card, chat, thread }) {
  const box = (one) => `${Math.round(one.left)},${Math.round(one.top)} ${Math.round(one.width)}x${Math.round(one.height)}`
  return `card ${box(card)} in chat ${box(chat)} over thread at y=${Math.round(thread.top)}`
}

export function settle(page) {
  return page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})))
  })
}

export function deckPlace(page) {
  return page.getByTestId('preview-deck').evaluate(node => {
    const box = node.getBoundingClientRect(), chat = node.parentElement.getBoundingClientRect()
    return { x: box.x - chat.x, y: box.y - chat.y, right: chat.right - box.right }
  })
}

export function flowGeometry(page) {
  return page.evaluate(() => {
    const rect = node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height] }
    const thread = document.querySelector('.bots-thread')
    return [[...rect(thread), thread.scrollHeight, thread.scrollTop], rect(document.querySelector('.bots-chat textarea')),
      ...[...document.querySelectorAll('.bots-thread .bubble-msg')].slice(0, 2).map(rect)]
  })
}

export function stackExposed(page) {
  return page.getByTestId('preview-deck').evaluate(node => {
    const chat = node.parentElement.getBoundingClientRect()
    const floor = node.parentElement.querySelector(':scope > .bots-thread').getBoundingClientRect().bottom
    const failed = [...node.querySelectorAll('.preview-deck-card')].map(card => {
      const box = card.getBoundingClientRect()
      const inside = box.left >= chat.left - 1 && box.top >= chat.top - 1 && box.right <= chat.right + 1 && box.bottom <= floor + 1
      const hit = card.contains(document.elementFromPoint(box.left + 8, box.top + 8))
      return inside && hit ? '' : `${card.dataset.position}@${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}${hit ? '' : ' covered'}`
    }).filter(Boolean)
    return failed.join('; ')
  })
}
