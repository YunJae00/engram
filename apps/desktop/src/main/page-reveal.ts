import type { Frame, Page } from 'playwright-core'
import type { PageMove } from 'core'
import { HAND_MARK } from './page-reader.js'
import { FIND_TIMEOUT_MS, settle, signature, unmark } from './page-actions.js'

function markOpener(input: { word: string; mark: string }): string | null {
  const folded = (el: Element): boolean =>
    (el as HTMLElement).hidden || getComputedStyle(el).display === 'none' || (el.closest('details:not([open])') !== null && el.closest('summary') === null)
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && !folded(el)
  }
  const wanted = input.word.toLowerCase()
  let held: Element | null = null
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!(el.textContent ?? '').toLowerCase().includes(wanted)) continue
    if (!folded(el)) continue
    held = el
  }
  if (!held) return null
  for (let up: Element | null = held; up; up = up.parentElement) {
    const opener =
      (up.tagName === 'DETAILS' ? up.querySelector('summary') : null) ??
      (up.parentElement?.tagName === 'DETAILS' ? up.parentElement.querySelector('summary') : null) ??
      (up.id ? document.querySelector('[aria-controls="' + CSS.escape(up.id) + '"]') : null) ??
      (up.previousElementSibling && shown(up.previousElementSibling) && up.previousElementSibling.getAttribute('aria-expanded') === 'false'
        ? up.previousElementSibling
        : null) ??
      (up.parentElement?.getAttribute('aria-expanded') === 'false' ? up.parentElement : null)
    if (opener && shown(opener)) {
      opener.setAttribute(input.mark, '')
      return ((opener as HTMLElement).innerText ?? opener.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'the section'
    }
  }
  return null
}

export async function revealText(page: Page, word: string): Promise<PageMove & { opened?: string }> {
  const roots: (Page | Frame)[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]
  for (const root of roots) {
    const named = await root.evaluate(markOpener, { word, mark: HAND_MARK }).catch(() => null)
    if (!named) continue
    const hand = root.locator(`[${HAND_MARK}]`).first()
    try {
      const before = await signature(page)
      await hand.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS })
      await hand.click({ timeout: FIND_TIMEOUT_MS }).catch(() => hand.dispatchEvent('click', undefined, { timeout: FIND_TIMEOUT_MS }))
      await settle(page)
      return { ok: true, opened: named, changed: (await signature(page)) !== before }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
    } finally {
      await unmark(page)
    }
  }
  return { ok: false, error: `nothing on this page is folded around "${word}" - the words may be on another page, or already shown` }
}
