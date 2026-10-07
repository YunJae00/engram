import type { Frame, Locator, Page } from 'playwright-core'
import type { PressTarget } from 'core'
import { HAND_MARK, placeOf, readDocument } from './page-reader.js'

// What a control is, read off the page before it is touched. Runs inside
// the page; nothing from outside is in scope.
export function inspectControl(node: Element): PressTarget & { field: boolean; secret: boolean; posts: boolean; select: boolean } {
  const STATE_ROLES = ['tab', 'switch', 'radio', 'checkbox', 'option', 'menuitemradio', 'menuitemcheckbox', 'treeitem']
  const el = node.closest('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[contenteditable="true"]') ?? node
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  const form = (el as HTMLInputElement | HTMLButtonElement).form ?? el.closest('form')
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

export async function handOn(page: Page, target: string, signal?: AbortSignal, selectors: string[] = []): Promise<Aim> {
  for (const selector of selectors.map(value => value.trim()).filter(Boolean)) {
    const matches = []
    for (const frame of page.frames()) {
      if (signal?.aborted) throw new Error('canceled')
      const hand = frame.locator(selector).filter({ visible: true })
      const count = await hand.count().catch(() => 0)
      if (count > 1) return { many: true }
      if (count === 1) matches.push(hand)
    }
    if (matches.length > 1) return { many: true }
    if (matches.length === 1) return { hand: matches[0]! }
  }
  if (!target.trim()) return { none: true }
  const numbered = /^#(\d+)/.exec(target.trim())
  if (numbered) {
    const place = placeOf(page, Number(numbered[1]))
    if (!place) return { none: true }
    // The control is tagged in the page so a locator can hold it; the tag
    // comes off with the next reading, which re-numbers everything.
    const fresh = await place.frame.evaluate(readDocument, place.local).catch(() => null)
    if (!fresh || !Array.isArray(fresh.controls) || JSON.stringify(fresh.controls[place.local - 1]) !== place.control) {
      await unmark(page)
      return { none: true }
    }
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
