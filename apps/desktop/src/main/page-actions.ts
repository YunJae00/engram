import type { Locator, Page } from 'playwright-core'
import { pressCommits, type PageMove } from 'core'
import { readFrames } from './page-reader.js'
import { scrollDirection } from './page-scroll.js'
import { handOn, inspectControl, unmark } from './page-target.js'
export { handOn, unmark } from './page-target.js'

// The hands a reader has on a page: press, type into a search box, choose
// from a list, scroll, hover, a key. Each moves around the page the way a
// person would and commits nothing - a control that would submit, save,
// send or buy is looked at before it is touched, and refused.

export const FIND_TIMEOUT_MS = 3_000
// Bound document readiness; content reads separately retry delayed results.
const SETTLE_LOAD_MS = 900
const SETTLE_MS = 300
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'])

// A page is given its moment after a move: the navigation it may have
// started, the requests that fill in what was pressed for, and a breath.
// No networkidle wait: a live site with analytics or a socket never goes idle,
// so that wait ran to its full timeout on every action and bought nothing.
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_LOAD_MS }).catch(() => undefined)
  await page.waitForTimeout(SETTLE_MS)
}

async function inspected(hand: Locator): Promise<ReturnType<typeof inspectControl> | null> {
  try {
    return await hand.evaluate(inspectControl, undefined, { timeout: FIND_TIMEOUT_MS })
  } catch {
    return null
  }
}

// The person's answer to "may this go?": the host asks them, with the page
// in front of them. No asker means the old refusal - nothing commits by
// accident because a caller forgot to wire the question.
export type Ask = (what: { words: string; url: string }) => Promise<'approve' | 'always' | 'cancel' | 'later'>

async function allowed(page: Page, words: string, ask?: Ask): Promise<'yes' | 'no' | 'theirs' | 'later'> {
  if (!ask) return 'no'
  const said = await ask({ words: words.slice(0, 80), url: page.url() }).catch(() => 'cancel' as const)
  // 'always' is remembered by the host; here both mean the press may go.
  if (said === 'approve' || said === 'always') return 'yes'
  if (said === 'later') return 'later'
  return 'theirs'
}

function missing(target: string): PageMove {
  // A number names the control as it was when the page was last read; if the
  // page has moved on since, the number is out of date, not the control gone.
  if (/^#\d+/.test(target.trim())) return { ok: false, error: `"${target}" no longer matches the page you read - it has changed since, or has no such number. Call read_open_page for the current numbers, then name the control again` }
  return { ok: false, error: `could not find "${target}" on the page` }
}

// The page in one short string: where it is, what it is called, and a
// sample of its words. Two of these being equal is what "nothing happened"
// means - the cheap way to tell a press that worked from one that landed
// on the wrong thing.
export async function signature(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? '').slice(0, 200_000)
      let hash = 0
      for (let i = 0; i < text.length; i += 7) hash = (hash * 31 + text.charCodeAt(i)) | 0
      return `${location.href}|${document.title}|${text.length}|${hash}`
    })
    .catch(() => '')
}

// Words that name more than one thing name nothing: the page is read once
// more and the numbers of everything that answers to them are handed back,
// so the next call can point at exactly one.
const CHOICES_LISTED = 8
async function ambiguity(page: Page, target: string): Promise<PageMove> {
  const reading = await readFrames(page).catch(() => null)
  const wanted = target.toLowerCase()
  const choices = (reading?.lines ?? []).filter((line) => {
    const name = line.replace(/^#\d+ \[[^\]]*\] /, '').replace(/ \([^)]*\)$/, '')
    return name.toLowerCase() === wanted || name.toLowerCase().includes(wanted)
  })
  const shown = choices.slice(0, CHOICES_LISTED).join(', ')
  return {
    ok: false,
    error: choices.length
      ? `"${target}" is on this page in more than one place - press one by its number: ${shown}`
      : `"${target}" is on this page in more than one place, and none of them is a control the page named; look at the page and press the point you mean`,
  }
}

// Where a hand is about to land, told to whoever shows the page: a person
// watching sees the pointer travel to the control before it is pressed,
// the way they would see a colleague's hand, instead of the page simply
// changing. Fractions of the viewport, so the picture can place it.
type PointerSink = (page: Page, x: number, y: number, kind: 'move' | 'press') => void
let pointerSink: PointerSink | null = null

export function setPointerSink(sink: PointerSink | null): void {
  pointerSink = sink
}

async function showHand(page: Page, hand: Locator, kind: 'move' | 'press'): Promise<void> {
  if (!pointerSink) return
  try {
    const box = await hand.boundingBox({ timeout: 1_000 })
    const size = page.viewportSize()
    if (!box || !size) return
    pointerSink(page, (box.x + box.width / 2) / size.width, (box.y + box.height / 2) / size.height, kind)
  } catch {
    // A control that will not say where it is is still pressed; only the
    // picture goes without the pointer.
  }
}

export async function pressOn(page: Page, target: string, signal?: AbortSignal, ask?: Ask): Promise<PageMove> {
  const aim = await handOn(page, target, signal)
  if ('many' in aim) return ambiguity(page, target)
  if ('none' in aim) return missing(target)
  const hand = aim.hand
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (pressCommits(control)) {
      const said = await allowed(page, control.words, ask)
      if (said !== 'yes') return { ok: false, refused: control.words.slice(0, 80), ...(said === 'theirs' ? { theirs: true } : said === 'later' ? { later: true } : {}) }
    }
    const before = await signature(page)
    await hand.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS })
    await showHand(page, hand, 'press')
    signal?.throwIfAborted()
    // A click timeout can happen after dispatch. Never retry it as a DOM event.
    await hand.click({ timeout: FIND_TIMEOUT_MS })
    await settle(page)
    return { ok: true, changed: (await signature(page)) !== before }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  } finally {
    await unmark(page)
  }
}

// Words into a search or filter box. Enter goes with them only where it
// asks a page for something (a form that gets); a form that posts is the
// person's to send.
export async function typeText(page: Page, target: string, text: string, enter: boolean, signal?: AbortSignal): Promise<PageMove> {
  const aim = await handOn(page, target, signal)
  if ('many' in aim) return ambiguity(page, target)
  if ('none' in aim) return missing(target)
  const hand = aim.hand
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (control.secret) return { ok: false, refused: 'a password field' }
    if (!control.field) return { ok: false, error: `"${target}" is not a field to type into` }
    if (enter && control.posts) return { ok: false, refused: `${control.words || target} - Enter here would post the form` }
    const before = enter ? await signature(page) : ''
    await showHand(page, hand, 'move')
    await hand.fill(text, { timeout: FIND_TIMEOUT_MS })
    if (enter) await hand.press('Enter', { timeout: FIND_TIMEOUT_MS })
    await settle(page)
    return enter ? { ok: true, changed: (await signature(page)) !== before } : { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  } finally {
    await unmark(page)
  }
}

// One entry from a list: a select's option by its words, or a custom list
// opened by a press and the entry pressed in it.
export async function chooseOption(page: Page, target: string, option: string, signal?: AbortSignal): Promise<PageMove> {
  const aim = await handOn(page, target, signal)
  if ('many' in aim) return ambiguity(page, target)
  if ('none' in aim) return missing(target)
  const hand = aim.hand
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (control.select) {
      try {
        await showHand(page, hand, 'press')
        await hand.selectOption({ label: option }, { timeout: FIND_TIMEOUT_MS })
      } catch {
        await hand.selectOption(option, { timeout: FIND_TIMEOUT_MS })
      }
      await settle(page)
      return { ok: true }
    }
    if (pressCommits(control)) return { ok: false, refused: control.words.slice(0, 80) }
    await hand.click({ timeout: FIND_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS)
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  } finally {
    await unmark(page)
  }
  return pressOn(page, option, signal)
}

// Never guess the picture's dimensions when its frame is unavailable.
async function viewport(page: Page): Promise<{ width: number; height: number } | null> {
  try {
    const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    return size && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0 ? size : null
  } catch { return null }
}

const NO_VIEWPORT: PageMove = { ok: false, error: 'The page viewport is unavailable; no pointer action was made. Call read_open_page or look to re-observe it before trying again; if it stays unavailable, use another source or report the blocker.' }

// Further down (or up) the page, or to where some words are, so a long or
// endless list brings the next of itself in.
export async function scrollPage(page: Page, to: string, signal?: AbortSignal): Promise<PageMove> {
  try {
    signal?.throwIfAborted()
    const where = to.trim().toLowerCase()
    const direction = ['down', 'up', 'left', 'right', 'bottom', 'top'].includes(where)
    const moved = direction ? await scrollDirection(page, where) : null
    if (moved !== null) {
      await settle(page)
      return { ok: true, changed: moved }
    } else if (direction) {
      const size = await viewport(page)
      if (!size) return NO_VIEWPORT
      signal?.throwIfAborted()
      const step = Math.round(size.height * 0.8)
      if (where === 'bottom' || where === 'top')
        await page.evaluate((end) => window.scrollTo({ top: end ? document.documentElement.scrollHeight : 0 }), where === 'bottom')
      await page.mouse.move(Math.round(size.width / 2), Math.round(size.height / 2))
      if (where === 'left' || where === 'right') await page.mouse.wheel(where === 'right' ? size.width * 0.8 : -size.width * 0.8, 0)
      else await page.mouse.wheel(0, where === 'down' || where === 'bottom' ? step : -step)
    } else {
      const aim = await handOn(page, to, signal)
      if ('many' in aim) return ambiguity(page, to)
      if ('none' in aim) return missing(to)
      await aim.hand.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS })
      await unmark(page)
    }
    await settle(page)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}

// A press where the picture shows it. The point is looked at first - what
// sits there is inspected exactly as a named control would be - so this is
// a way to reach a thing, never a way around the guard.
export async function pressPoint(page: Page, x: number, y: number, ask?: Ask, signal?: AbortSignal): Promise<PageMove> {
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { ok: false, error: 'a point is given in fractions of the picture, between 0 and 1' }
  try {
    signal?.throwIfAborted()
    const size = await viewport(page)
    if (!size) return NO_VIEWPORT
    const at = { x: Math.round(x * size.width), y: Math.round(y * size.height) }
    const target = await page.evaluateHandle((point) => {
      let el = document.elementFromPoint(point.x, point.y)
      while (el?.shadowRoot) {
        const child = el.shadowRoot.elementFromPoint(point.x, point.y)
        if (!child || child === el) break
        el = child
      }
      return el?.matches('iframe,frame') ? null : el
    }, at)
    let there: ReturnType<typeof inspectControl> | null
    try {
      const hand = target.asElement()
      there = hand ? await hand.evaluate(inspectControl) : null
    } finally { await target.dispose() }
    if (!there) return { ok: false, error: 'nothing is at that point of the picture' }
    if (pressCommits(there)) {
      const said = await allowed(page, there.words, ask)
      if (said !== 'yes') return { ok: false, refused: there.words || 'what is at that point', ...(said === 'theirs' ? { theirs: true } : said === 'later' ? { later: true } : {}) }
    }
    const before = await signature(page)
    signal?.throwIfAborted()
    pointerSink?.(page, x, y, 'press')
    await page.mouse.click(at.x, at.y)
    await settle(page)
    return { ok: true, changed: (await signature(page)) !== before }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}

export async function hoverOn(page: Page, target: string, signal?: AbortSignal): Promise<PageMove> {
  const aim = await handOn(page, target, signal)
  if ('many' in aim) return ambiguity(page, target)
  if ('none' in aim) return missing(target)
  try {
    await showHand(page, aim.hand, 'move')
    await aim.hand.hover({ timeout: FIND_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS * 2)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  } finally {
    await unmark(page)
  }
}

// A key to the page: Escape for a dialog, arrows in a picker, Tab along.
// Activation keys inspect the current control, including framed/shadow content.
export async function pressKey(page: Page, key: string, signal?: AbortSignal): Promise<PageMove> {
  if (signal?.aborted) throw new Error('canceled')
  if (!KEYS.has(key)) return { ok: false, error: `"${key}" is not a key that can be pressed here; one of ${[...KEYS].join(', ')}` }
  try {
    const before = await signature(page)
    if (key === 'Enter' || key === 'Space') {
      let frame = page.mainFrame()
      for (;;) {
        const active = await frame.evaluateHandle(() => {
          let node = document.activeElement
          while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement
          return node
        })
        try {
          const hand = active.asElement()
          if (!hand) return { ok: false, error: 'The focused control could not be inspected' }
          const child = await hand.contentFrame()
          if (child) { frame = child; continue }
          const control = await hand.evaluate(inspectControl)
          if (control.secret || control.posts || (!control.field && pressCommits(control)))
            return { ok: false, refused: `${key} here could submit or commit something` }
          if (signal?.aborted) throw new Error('canceled')
          await hand.press(key, { timeout: FIND_TIMEOUT_MS })
          break
        } finally {
          await active.dispose()
        }
      }
    } else {
      if (signal?.aborted) throw new Error('canceled')
      await page.keyboard.press(key)
    }
    await settle(page)
    return { ok: true, changed: (await signature(page)) !== before }
  } catch (err) {
    if (signal?.aborted) throw new Error('canceled')
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}
