import type { Frame, Page } from 'playwright-core'

// What a picture of the page must not carry to a brain: the fields the page
// itself declares secret. The declaration is the page's own - the type a
// browser masks with dots, the autocomplete names it fills cards and codes
// into - so nothing here guesses at what a field holds. Each such field is
// covered with a black box for as long as the picture takes, in the page
// and in every frame of it, and uncovered again after.

const SECRET_FIELDS = [
  'input[type="password"]',
  '[autocomplete^="cc-"]',
  '[autocomplete="one-time-code"]',
  '[autocomplete="current-password"]',
  '[autocomplete="new-password"]',
].join(', ')

const MARK = 'data-engram-mask'

// Runs inside a document. Self-contained: nothing from outside is in scope.
function coverSecrets({ selector, mark }: { selector: string; mark: string }): number {
  const seen = new Set<Element>()
  const walk = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll(selector))) seen.add(el)
    for (const el of Array.from(root.querySelectorAll('*'))) if (el.shadowRoot) walk(el.shadowRoot)
  }
  walk(document)
  let covered = 0
  for (const el of seen) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue
    const box = document.createElement('div')
    box.setAttribute(mark, '')
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#000;z-index:2147483647;pointer-events:none;border-radius:3px`
    document.documentElement.appendChild(box)
    covered++
  }
  return covered
}

function uncover(mark: string): void {
  for (const box of Array.from(document.querySelectorAll(`[${mark}]`))) box.remove()
}

async function eachFrame<T>(page: Page, work: (frame: Frame) => Promise<T>): Promise<T[]> {
  const out: T[] = []
  for (const frame of page.frames()) {
    try {
      out.push(await work(frame))
    } catch {
      // A frame that will not answer (cross-origin lock, mid-navigation)
      // is left as it is; the picture of it is the page's own risk to name.
    }
  }
  return out
}

// Covers every secret field the page shows; returns how many, and the hand
// that uncovers them again.
export async function maskSecrets(page: Page): Promise<{ covered: number; uncover(): Promise<void> }> {
  const counts = await eachFrame(page, (frame) => frame.evaluate(coverSecrets, { selector: SECRET_FIELDS, mark: MARK }) as Promise<number>)
  return {
    covered: counts.reduce((n, one) => n + one, 0),
    uncover: async () => {
      await eachFrame(page, (frame) => frame.evaluate(uncover, MARK))
    },
  }
}
