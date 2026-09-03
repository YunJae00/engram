import type { Frame, Locator, Page } from 'playwright-core'
import { pressCommits, type PageMove, type PressTarget } from 'core'
import { HAND_MARK, placeOf, readDocument, readFrames } from './page-reader.js'

// The hands a reader has on a page: press, type into a search box, choose
// from a list, scroll, hover, a key. Each moves around the page the way a
// person would and commits nothing - a control that would submit, save,
// send or buy is looked at before it is touched, and refused.

export const FIND_TIMEOUT_MS = 3_000
const SETTLE_NETWORK_MS = 2_500
const SETTLE_MS = 300
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'])

// What a control is, read off the page before it is touched. Runs inside
// the page; nothing from outside is in scope.
function inspectControl(node: Element): PressTarget & { field: boolean; secret: boolean; posts: boolean; select: boolean } {
  const STATE_ROLES = ['tab', 'switch', 'radio', 'checkbox', 'option', 'menuitemradio', 'menuitemcheckbox', 'treeitem']
  const el = node.closest('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[contenteditable="true"]') ?? node
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  const form = el.closest('form')
  const submits = (tag === 'button' && form !== null && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image'))
  const words = [(el as HTMLElement).innerText ?? el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('value') ?? '', el.getAttribute('title') ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const field =
    tag === 'textarea' ||
    (el as HTMLElement).isContentEditable ||
    ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role') ?? '') ||
    (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(type))
  const role = el.getAttribute('role') ?? ''
  // Passage: something that takes the person somewhere or opens something,
  // rather than acting for them.
  const navigates =
    (tag === 'a' && el.hasAttribute('href')) ||
    ['link', 'menuitem', 'tab', 'treeitem'].includes(role) ||
    el.hasAttribute('aria-haspopup') ||
    el.closest('nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"]') !== null
  const shows =
    !submits &&
    (STATE_ROLES.includes(role) ||
      el.hasAttribute('aria-pressed') ||
      el.hasAttribute('aria-selected') ||
      el.hasAttribute('aria-expanded') ||
      (tag === 'input' && (type === 'radio' || type === 'checkbox')) ||
      (tag === 'label' && el.querySelector('input[type="radio"], input[type="checkbox"]') !== null) ||
      tag === 'option' ||
      tag === 'summary')
  return {
    submits,
    words,
    shows,
    navigates,
    field,
    secret: tag === 'input' && type === 'password',
    posts: form !== null && (form.getAttribute('method') ?? 'get').toLowerCase() === 'post',
    select: tag === 'select',
  }
}

// Every way a page can name a control, in the order a person would look;
// only what is on screen counts, and frames count as the page.
function locators(root: Page | Frame, text: string): Locator[] {
  const exact = { name: text, exact: true }
  const attr = text.replace(/["\\]/g, (char) => `\\${char}`)
  return [
    root.getByRole('button', exact),
    root.getByRole('tab', exact),
    root.getByRole('link', exact),
    root.getByRole('menuitem', exact),
    root.getByRole('option', exact),
    root.getByRole('textbox', exact),
    root.getByRole('combobox', exact),
    root.getByRole('button', { name: text }),
    root.getByRole('link', { name: text }),
    root.getByLabel(text),
    root.getByPlaceholder(text),
    root.getByTitle(text),
    root.getByAltText(text),
    root.getByText(text, { exact: true }),
    root.getByText(text, { exact: false }),
    root.locator(`[name="${attr}"], [value="${attr}"], [data-title="${attr}"], [data-tooltip="${attr}"]`),
  ].map((one) => one.filter({ visible: true }))
}

// A hand on what the target names - by number from the last reading ("#12"),
// or by the words on it, or the reason there is none: nothing of
// that name, or several things of it.
type Aim = { hand: Locator } | { none: true } | { many: true }

async function handOn(page: Page, target: string, signal?: AbortSignal): Promise<Aim> {
  const numbered = /^#(\d+)/.exec(target.trim())
  if (numbered) {
    const place = placeOf(page, Number(numbered[1]))
    if (!place) return { none: true }
    // The control is tagged in the page so a locator can hold it; the tag
    // comes off with the next reading, which re-numbers everything.
    await place.frame.evaluate(readDocument, place.local).catch(() => undefined)
    const hand = place.frame.locator(`[${HAND_MARK}]`).first()
    return (await hand.count().catch(() => 0)) > 0 ? { hand } : { none: true }
  }
  const roots: (Page | Frame)[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]
  for (const root of roots) {
    for (const hand of locators(root, target)) {
      if (signal?.aborted) throw new Error('canceled')
      const found = await hand.count().catch(() => 0)
      if (found === 1) return { hand: hand.first() }
      if (found > 1) {
        // A cell and the words inside it are one thing, not two: matches
        // that nest are the same control, read at different depths.
        const nested = await hand
          .evaluateAll((els) => els.every((el) => el === els[0] || els[0]!.contains(el) || el.contains(els[0]!)))
          .catch(() => false)
        if (nested) return { hand: hand.first() }
        // The same words in several places: the first one down the page is a
        // guess, and a guess here presses the wrong thing.
        return { many: true }
      }
    }
  }
  return { none: true }
}

export async function unmark(page: Page): Promise<void> {
  for (const frame of page.frames())
    await frame
      .evaluate((mark) => {
        for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) el.removeAttribute(mark)
      }, HAND_MARK)
      .catch(() => undefined)
}

// A page is given its moment after a move: the navigation it may have
// started, the requests that fill in what was pressed for, and a breath.
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_NETWORK_MS }).catch(() => undefined)
  await page.waitForLoadState('networkidle', { timeout: SETTLE_NETWORK_MS }).catch(() => undefined)
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
export type Ask = (what: { words: string; url: string }) => Promise<'approve' | 'always' | 'cancel'>

async function allowed(page: Page, words: string, ask?: Ask): Promise<'yes' | 'no' | 'theirs'> {
  if (!ask) return 'no'
  const said = await ask({ words: words.slice(0, 80), url: page.url() }).catch(() => 'cancel' as const)
  // 'always' is remembered by the host; here both mean the press may go.
  if (said === 'approve' || said === 'always') return 'yes'
  return 'theirs'
}

function missing(target: string): PageMove {
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
      if (said !== 'yes') return { ok: false, refused: control.words.slice(0, 80), ...(said === 'theirs' ? { theirs: true } : {}) }
    }
    const before = await signature(page)
    try {
      await hand.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS })
      await showHand(page, hand, 'press')
      await hand.click({ timeout: FIND_TIMEOUT_MS })
    } catch {
      // Something sits over it (a sticky bar, a fade): the press is delivered
      // to the control itself, as a page's own script would.
      await hand.dispatchEvent('click', undefined, { timeout: FIND_TIMEOUT_MS })
    }
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

// Further down (or up) the page, or to where some words are, so a long or
// endless list brings the next of itself in.
export async function scrollPage(page: Page, to: string, signal?: AbortSignal): Promise<PageMove> {
  const size = page.viewportSize() ?? { width: 1280, height: 800 }
  const step = Math.round(size.height * 0.8)
  try {
    const where = to.trim().toLowerCase()
    if (where === 'down' || where === 'up') {
      await page.mouse.move(Math.round(size.width / 2), Math.round(size.height / 2))
      await page.mouse.wheel(0, where === 'down' ? step : -step)
    } else if (where === 'bottom' || where === 'top') {
      await page.evaluate((end) => window.scrollTo({ top: end ? document.documentElement.scrollHeight : 0 }), where === 'bottom')
      await page.mouse.move(Math.round(size.width / 2), Math.round(size.height / 2))
      await page.mouse.wheel(0, where === 'bottom' ? step : -step)
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
export async function pressPoint(page: Page, x: number, y: number, ask?: Ask): Promise<PageMove> {
  const size = page.viewportSize() ?? { width: 1280, height: 800 }
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { ok: false, error: 'a point is given in fractions of the picture, between 0 and 1' }
  const at = { x: Math.round(x * size.width), y: Math.round(y * size.height) }
  try {
    const there = await page.evaluate((point) => {
      const el = document.elementFromPoint(point.x, point.y)
      if (!el) return null
      const words = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const form = el.closest('form')
      const tag = el.tagName.toLowerCase()
      const type = (el.getAttribute('type') ?? '').toLowerCase()
      return {
        words,
        submits: (tag === 'button' && form !== null && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image')),
      }
    }, at)
    if (!there) return { ok: false, error: 'nothing is at that point of the picture' }
    if (pressCommits(there)) {
      const said = await allowed(page, there.words, ask)
      if (said !== 'yes') return { ok: false, refused: there.words || 'what is at that point', ...(said === 'theirs' ? { theirs: true } : {}) }
    }
    const before = await signature(page)
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
// Enter is refused where what has the focus would post a form.
export async function pressKey(page: Page, key: string): Promise<PageMove> {
  if (!KEYS.has(key)) return { ok: false, error: `"${key}" is not a key that can be pressed here; one of ${[...KEYS].join(', ')}` }
  if (key === 'Enter') {
    const posts = await page
      .evaluate(() => {
        const form = document.activeElement?.closest('form')
        return form !== null && form !== undefined && (form.getAttribute('method') ?? 'get').toLowerCase() === 'post'
      })
      .catch(() => false)
    if (posts) return { ok: false, refused: 'Enter here would post the form' }
  }
  try {
    const before = await signature(page)
    await page.keyboard.press(key)
    await settle(page)
    return { ok: true, changed: (await signature(page)) !== before }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}
