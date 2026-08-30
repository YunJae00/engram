import type { Frame, Page } from 'playwright-core'

// A page read the way a person sees it: the words on it, the controls in
// the order they sit on it - each with a number, so an icon with no words
// can still be named - and the words a page keeps folded away, so a search
// for them can say where they are. Frames and open shadow roots are part
// of the page, not exceptions to it.

export interface FrameReading {
  text: string
  hidden: string
  hasPasswordField: boolean
  links: { text: string; url: string }[]
  controls: { kind: string; name: string; state: string }[]
}

export interface PageReading extends FrameReading {
  // Control lines as the model sees them: "#12 [button] Next (closed)".
  lines: string[]
}

// Where each numbered control lives, so a press by number lands on the
// element the reading meant: which frame, and which one there.
const placed = new WeakMap<Page, Map<number, { frame: Frame; local: number }>>()

export const HAND_MARK = 'data-engram-hand'
const FRAME_READ_MS = 12_000

// Runs inside a document. Self-contained: nothing from outside is in scope,
// not even this module's own constants.
// With `mark`, the control at that number (1-based, this document's own
// order) is tagged so a locator can pick it up; the tag is taken off again
// by the caller.
export function readDocument(mark?: number): FrameReading {
  const INTERACTIVE =
    'button, input, select, textarea, a[href], summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="combobox"], [role="switch"], [role="treeitem"], [role="textbox"], [role="searchbox"], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
  const CONTROLS_CAP = 150
  const HIDDEN_CAP = 20_000
  const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
  const shown = (el: Element): boolean => {
    const node = el as HTMLElement
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  // Every element in document order, through open shadow roots - parents
  // before their children, which is what lets folded-ness be inherited in
  // one pass. A page of tens of thousands of nodes is read to a cap.
  const ELEMENT_CAP = 30_000
  const all: Element[] = []
  const walk = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (all.length >= ELEMENT_CAP) return
      all.push(el)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  const parentOf = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null)
  // Folded once per element: its own display, or a folded ancestor's.
  const foldedOf = new Map<Element, boolean>()
  const ownFolded = new Map<Element, boolean>()
  for (const el of all) {
    const own = (el as HTMLElement).hidden || getComputedStyle(el).display === 'none'
    ownFolded.set(el, own)
    const parent = parentOf(el)
    foldedOf.set(el, own || (parent ? (foldedOf.get(parent) ?? false) : false))
  }
  // The visible words: what the page shows, plus what its shadow trees show
  // (a host's own text leaves its shadow tree out).
  const main = (document.querySelector('article, main') ?? document.body) as HTMLElement | null
  let text = (main?.innerText ?? '').replace(/\n{3,}/g, '\n\n')
  for (const el of all)
    if (el.shadowRoot)
      for (const child of Array.from(el.shadowRoot.children)) {
        const words = (child as HTMLElement).innerText ?? ''
        if (words.trim()) text += `\n${words}`
      }
  // The folded words: each outermost hidden element's text, so "is it on
  // this page at all" can be answered without opening every tab.
  const hidden: string[] = []
  let hiddenLength = 0
  for (const el of all) {
    if (SKIP.has(el.tagName) || !ownFolded.get(el)) continue
    const parent = parentOf(el)
    if (parent && foldedOf.get(parent)) continue
    const words = clean(el.textContent)
    if (words.length < 20) continue
    hidden.push(words.slice(0, 2_000))
    hiddenLength += Math.min(words.length, 2_000)
    if (hiddenLength > HIDDEN_CAP) break
  }
  // Every link that goes somewhere else, with the words on it.
  const seen = new Set<string>()
  const links: { text: string; url: string }[] = []
  for (const el of all) {
    if (el.tagName !== 'A') continue
    const href = (el as HTMLAnchorElement).href
    const label = clean((el as HTMLElement).innerText)
    if (!/^https?:/.test(href) || label.length < 4 || seen.has(href)) continue
    try {
      if (new URL(href).href.split('#')[0] === location.href.split('#')[0]) continue
    } catch {
      continue
    }
    seen.add(href)
    links.push({ text: label.slice(0, 120), url: href })
    if (links.length >= 25) break
  }
  // What a control is called: every place a page puts a name, in the order
  // a person would find one; an icon with no words at all is named by the
  // hint in its class, or left nameless and known by its number.
  const textOfIds = (ids: string | null): string =>
    (ids ?? '')
      .split(/\s+/)
      .map((id) => clean(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(' ')
  const names = new Map<Element, string>()
  const nameOf = (el: Element): string => {
    const known = names.get(el)
    if (known !== undefined) return known
    const name = nameFor(el)
    names.set(el, name)
    return name
  }
  const nameFor = (el: Element): string => {
    const node = el as HTMLElement
    const own = clean(node.innerText)
    const candidates = [
      node.getAttribute('aria-label'),
      textOfIds(node.getAttribute('aria-labelledby')),
      node.getAttribute('title'),
      Array.from(node.querySelectorAll('img[alt]'))
        .map((img) => img.getAttribute('alt'))
        .join(' '),
      clean(node.querySelector('svg > title')?.textContent),
      own.length <= 80 ? own : own.slice(0, 77) + '…',
      node.getAttribute('placeholder'),
      node.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(node.getAttribute('type') ?? '') ? node.getAttribute('value') : null,
      node.id ? clean(document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent) : null,
      clean(node.closest('label')?.textContent),
      node.getAttribute('name'),
      node.getAttribute('data-tooltip') ?? node.getAttribute('data-title') ?? node.getAttribute('data-original-title'),
    ]
    for (const one of candidates) {
      const value = clean(one)
      if (value) return value.slice(0, 80)
    }
    const hint = (node.className && typeof node.className === 'string' ? node.className : '').match(
      /\b(prev|previous|next|close|search|menu|expand|collapse|arrow|calendar|filter|back|forward|up|down|left|right|first|last|more|plus|minus|add|remove|toggle|settings|home)\b/i,
    )
    return hint ? `(icon: ${hint[1]!.toLowerCase()})` : ''
  }
  const controls: { kind: string; name: string; state: string }[] = []
  let marked: Element | null = null
  for (const el of all) {
    if (foldedOf.get(el) || !el.matches(INTERACTIVE) || !shown(el)) continue
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    if (tag === 'input' && type === 'hidden') continue
    // A control wrapped in a control (an image inside a link inside a
    // button) is one control, the outer one.
    const outer = el.parentElement?.closest(INTERACTIVE)
    if (outer && shown(outer) && nameOf(outer) === nameOf(el)) continue
    const kind = el.getAttribute('role') ?? (tag === 'input' ? `input:${type || 'text'}` : tag === 'a' ? 'link' : tag)
    const expanded = el.getAttribute('aria-expanded')
    const input = el as HTMLInputElement
    const state = [
      expanded === 'true' ? 'open' : expanded === 'false' ? 'closed' : '',
      el.getAttribute('aria-selected') === 'true' || (tag === 'input' && (type === 'checkbox' || type === 'radio') && input.checked) ? 'selected' : '',
      (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
    ]
      .filter(Boolean)
      .join(', ')
    controls.push({ kind, name: nameOf(el), state })
    if (mark === controls.length) marked = el
    if (controls.length >= CONTROLS_CAP) break
  }
  if (marked) marked.setAttribute('data-engram-hand', '')
  return { text, hidden: hidden.join('\n'), hasPasswordField: document.querySelector('input[type="password"]') !== null, links, controls }
}

function frameName(frame: Frame): string {
  return frame.name() || frame.url().slice(0, 80)
}

// The whole page: every frame read, the controls numbered straight through,
// and where each number lives kept for the next press.
export async function readFrames(page: Page): Promise<PageReading> {
  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]
  const map = new Map<number, { frame: Frame; local: number }>()
  const whole: PageReading = { text: '', hidden: '', hasPasswordField: false, links: [], controls: [], lines: [] }
  for (const frame of frames) {
    let reading: FrameReading
    try {
      // A frame that will not answer (a script in a loop, a page far too
      // large) is left out rather than holding the whole read.
      reading = await Promise.race([
        frame.evaluate(readDocument, undefined),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('frame read timed out')), FRAME_READ_MS)),
      ])
    } catch {
      continue
    }
    if (!reading.text.trim() && reading.controls.length === 0) continue
    whole.text += (whole.text && reading.text.trim() ? `\n\n[frame: ${frameName(frame)}]\n` : '') + reading.text
    whole.hidden += (whole.hidden && reading.hidden ? '\n' : '') + reading.hidden
    whole.hasPasswordField ||= reading.hasPasswordField
    whole.links.push(...reading.links)
    reading.controls.forEach((control, at) => {
      const index = whole.controls.length + 1
      whole.controls.push(control)
      map.set(index, { frame, local: at + 1 })
      whole.lines.push(`#${index} [${control.kind}] ${control.name || '(no words)'}${control.state ? ` (${control.state})` : ''}`)
    })
  }
  whole.links = whole.links.slice(0, 25)
  placed.set(page, map)
  return whole
}

// The frame and local number behind a control number from the last reading.
export function placeOf(page: Page, index: number): { frame: Frame; local: number } | null {
  return placed.get(page)?.get(index) ?? null
}
