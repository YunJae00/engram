import type { Frame, Locator, Page } from 'playwright-core'
import { pressCommits, type PageMove, type PressTarget } from 'core'
import { HAND_MARK, placeOf, readDocument } from './page-reader.js'

// The hands a reader has on a page: press, type into a search box, choose
// from a list, scroll, hover, a key. Each moves around the page the way a
// person would and commits nothing - a control that would submit, save,
// send or buy is looked at before it is touched, and refused.

const FIND_TIMEOUT_MS = 3_000
const SETTLE_NETWORK_MS = 2_500
const SETTLE_MS = 300
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'])

// What a control is, read off the page before it is touched. Runs inside
// the page; nothing from outside is in scope.
function inspectControl(node: Element): PressTarget & { field: boolean; secret: boolean; posts: boolean; select: boolean } {
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
  return {
    submits,
    words,
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
  ].map((one) => one.filter({ visible: true }).first())
}

// A hand on the control the target names: by number from the last reading
// ("#12"), or by the words on it.
async function handOn(page: Page, target: string, signal?: AbortSignal): Promise<Locator | null> {
  const numbered = /^#(\d+)/.exec(target.trim())
  if (numbered) {
    const place = placeOf(page, Number(numbered[1]))
    if (!place) return null
    // The control is tagged in the page so a locator can hold it; the tag
    // comes off with the next reading, which re-numbers everything.
    await place.frame.evaluate(readDocument, place.local).catch(() => undefined)
    const hand = place.frame.locator(`[${HAND_MARK}]`).first()
    return (await hand.count().catch(() => 0)) > 0 ? hand : null
  }
  const roots: (Page | Frame)[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]
  for (const root of roots) {
    for (const hand of locators(root, target)) {
      if (signal?.aborted) throw new Error('canceled')
      if ((await hand.count().catch(() => 0)) > 0) return hand
    }
  }
  return null
}

async function unmark(page: Page): Promise<void> {
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

function missing(target: string): PageMove {
  return { ok: false, error: `could not find "${target}" on the page` }
}

export async function pressOn(page: Page, target: string, signal?: AbortSignal): Promise<PageMove> {
  const hand = await handOn(page, target, signal)
  if (!hand) return missing(target)
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (pressCommits(control)) return { ok: false, refused: control.words.slice(0, 80) }
    try {
      await hand.click({ timeout: FIND_TIMEOUT_MS })
    } catch {
      // Something sits over it (a sticky bar, a fade): the press is delivered
      // to the control itself, as a page's own script would.
      await hand.dispatchEvent('click', undefined, { timeout: FIND_TIMEOUT_MS })
    }
    await settle(page)
    return { ok: true }
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
  const hand = await handOn(page, target, signal)
  if (!hand) return missing(target)
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (control.secret) return { ok: false, refused: 'a password field' }
    if (!control.field) return { ok: false, error: `"${target}" is not a field to type into` }
    if (enter && control.posts) return { ok: false, refused: `${control.words || target} - Enter here would post the form` }
    await hand.fill(text, { timeout: FIND_TIMEOUT_MS })
    if (enter) await hand.press('Enter', { timeout: FIND_TIMEOUT_MS })
    await settle(page)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  } finally {
    await unmark(page)
  }
}

// One entry from a list: a select's option by its words, or a custom list
// opened by a press and the entry pressed in it.
export async function chooseOption(page: Page, target: string, option: string, signal?: AbortSignal): Promise<PageMove> {
  const hand = await handOn(page, target, signal)
  if (!hand) return missing(target)
  try {
    const control = await inspected(hand)
    if (!control) return missing(target)
    if (control.select) {
      try {
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
      const hand = await handOn(page, to, signal)
      if (!hand) return missing(to)
      await hand.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS })
      await unmark(page)
    }
    await settle(page)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}

export async function hoverOn(page: Page, target: string, signal?: AbortSignal): Promise<PageMove> {
  const hand = await handOn(page, target, signal)
  if (!hand) return missing(target)
  try {
    await hand.hover({ timeout: FIND_TIMEOUT_MS })
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
    await page.keyboard.press(key)
    await settle(page)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}
