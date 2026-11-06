// The chat as packed blocks: the live card, the thread and the composer
// measured in the window, and the rules an overlay card has to keep.
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
    const input = document.querySelector('.bots-chat textarea')
    if (!chat || !main || !card || !thread || !input) return null
    const controls = [...chat.querySelectorAll('textarea, .decision-card button, .bubble-msg')]
      .filter((node) => !card.contains(node))
      .map((node) => ({ ...rect(node), inThread: thread.contains(node) }))
    const center = { x: (card.getBoundingClientRect().left + card.getBoundingClientRect().right) / 2, y: (card.getBoundingClientRect().top + card.getBoundingClientRect().bottom) / 2 }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      main: rect(main), chat: rect(chat), card: rect(card), thread: rect(thread), input: rect(input), controls,
      cardOnTop: card.contains(document.elementFromPoint(center.x, center.y)),
      pane: document.querySelector('.web-pane') !== null,
    }
  })
}

const inside = (box, outer, slack = 1) => box.left >= outer.left - slack && box.right <= outer.right + slack && box.top >= outer.top - slack && box.bottom <= outer.bottom + slack

export function packedBlocks(measure) {
  if (!measure) return { ok: false, reasons: ['chat, card, thread or composer is missing'] }
  const { viewport, main, chat, card, thread, input, controls, cardOnTop, pane } = measure
  const reasons = []
  if (card.right > viewport.width + 1 || card.bottom > viewport.height + 1) reasons.push('card leaves the window')
  if (!inside(card, chat)) reasons.push('card leaves the chat')
  if (card.bottom > thread.top + 1) reasons.push('card covers the thread')
  if (!inside(input, chat)) reasons.push('composer leaves the chat')
  if (Math.abs(chat.width - main.width) >= 2) reasons.push('chat is narrowed beside the card')
  if (pane) reasons.push('a web pane is open beside the chat')
  if (!cardOnTop) reasons.push('something paints over the card')
  for (const control of controls) {
    const top = control.inThread ? Math.max(control.top, thread.top) : control.top
    const bottom = control.inThread ? Math.min(control.bottom, thread.bottom) : control.bottom
    if (bottom <= top) continue
    const apart = bottom <= card.top || top >= card.bottom || control.right <= card.left || control.left >= card.right
    if (!apart) { reasons.push('card covers a control'); break }
  }
  return { ok: reasons.length === 0, reasons }
}

export function describeBlocks({ card, chat, thread }) {
  const box = (one) => `${Math.round(one.left)},${Math.round(one.top)} ${Math.round(one.width)}x${Math.round(one.height)}`
  return `card ${box(card)} in chat ${box(chat)} above thread at y=${Math.round(thread.top)}`
}
