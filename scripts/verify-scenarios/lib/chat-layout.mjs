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
    const deck = document.querySelector('.preview-deck')
    const back = [...document.querySelectorAll('.preview-deck-card:not([data-position="0"])')]
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stack: [...document.querySelectorAll('.preview-deck-card')].map(rect),
      main: rect(main), chat: rect(chat), card: rect(card), thread: rect(thread), composer: rect(composer), input: rect(input),
      cardOnTop: [(box.top + box.bottom) / 2, box.top + 5, box.bottom - 5].every(y => card.contains(document.elementFromPoint(middle, y))),
      cornersOnTop: back.every(node => { const one = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(one.left + 5, one.top + 5)) }),
      suspended: deck?.hasAttribute('data-suspended') ?? false,
      pane: document.querySelector('.web-pane') !== null,
    }
  })
}

const inside = (box, outer, slack = 1) => box.left >= outer.left - slack && box.right <= outer.right + slack && box.top >= outer.top - slack && box.bottom <= outer.bottom + slack

export function packedBlocks(measure) {
  if (!measure) return { ok: false, reasons: ['chat, card, thread or composer is missing'] }
  const { viewport, main, chat, card, thread, composer, stack, input, cardOnTop, cornersOnTop, suspended, pane } = measure
  const reasons = []
  if (suspended) reasons.push('the overlay is suspended for lack of space')
  if (card.right > viewport.width + 1 || card.bottom > viewport.height + 1) reasons.push('card leaves the window')
  if (!inside(card, chat)) reasons.push(`card leaves the chat: ${describeBlocks(measure)}`)
  if (stack.some(box => !inside(box, chat))) reasons.push('stack leaves the chat')
  if (stack.some(box => box.bottom > thread.bottom + 1)) reasons.push('stack runs past the thread')
  if (card.bottom > thread.bottom + 1 || card.bottom > composer.top) reasons.push(`card runs past the thread onto the composer: ${describeBlocks(measure)}`)
  if (!inside(input, chat)) reasons.push('composer leaves the chat')
  if (Math.abs(chat.width - main.width) >= 2) reasons.push('chat is narrowed beside the card')
  if (pane) reasons.push('a web pane is open beside the chat')
  if (!cardOnTop) reasons.push('something paints over the card')
  if (!cornersOnTop) reasons.push('an exposed back-card corner is covered')
  return { ok: reasons.length === 0, reasons }
}

export function describeBlocks({ card, chat, thread }) {
  const box = (one) => `${Math.round(one.left)},${Math.round(one.top)} ${Math.round(one.width)}x${Math.round(one.height)}`
  return `card ${box(card)} in chat ${box(chat)} over thread ending at y=${Math.round(thread.bottom)}`
}

export function settleAnimations(page) {
  return page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
}

// The thread, composer and first bubbles must not move when the overlay appears, drags or disappears.
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

export function deckOffset(deck) {
  return deck.evaluate(node => {
    const box = node.getBoundingClientRect(), chat = node.parentElement.getBoundingClientRect()
    return { x: box.x - chat.x, y: box.y - chat.y, right: chat.right - box.right }
  })
}

export function deckInline(deck) {
  return deck.evaluate(node => [node.style.left, node.style.top, node.hasAttribute('data-dragging'), node.hasAttribute('data-suspended')])
}

export function stackBounded(deck) {
  return deck.evaluate(node => {
    const chat = node.parentElement.getBoundingClientRect()
    const thread = node.parentElement.querySelector('.bots-thread').getBoundingClientRect()
    return [...node.querySelectorAll('.preview-deck-card')].every(card => {
      const box = card.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + 5, box.top + 5)
      return box.left >= chat.left - 1 && box.top >= chat.top - 1
        && box.right <= chat.right + 1 && box.bottom <= Math.min(chat.bottom, thread.bottom) + 1 && card.contains(hit)
    })
  })
}

export function controlsUsable(card) {
  return card.evaluate(node => [...node.querySelectorAll('.preview-card-actions button')].every(button => {
    const box = button.getBoundingClientRect()
    return box.width >= 24 && box.height >= 24 && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  }))
}
