import type { TeachEvent } from 'core'
import {
  agentContext,
  agentPage,
  agentPages,
  agentWorkPage,
  claimAgentBrowser,
  closeAgentBrowser,
  holdAgentBrowser,
} from './agent-browser.js'

type Page = import('playwright-core').Page

// ── Teach mode ──────────────────────────────────────────────────────────
// Recording a person's real moves in the agent window and handing them back
// as raw events. The transform into steps (and the rule that a login is never
// written down) lives in core; here we only watch. A password field on the
// page suppresses every click and keystroke on it — the human's login is the
// human's alone.
let teachEvents: TeachEvent[] | null = null
let releaseTeachHold: (() => void) | null = null

// Injected at document-start into every top document the user visits. It posts
// clicks and finished edits to the exposed binding, tagging anything that
// happens beside a password field so core can drop it.
const RECORDER = (): void => {
  const w = window as unknown as { __engramTeach?: (e: unknown) => void; __engramRec?: boolean }
  if (window.top !== window || w.__engramRec) return
  w.__engramRec = true
  const walled = (): boolean => document.querySelector('input[type="password"]') !== null
  const send = (e: unknown): void => {
    try {
      w.__engramTeach?.(e)
    } catch {
      /* binding not ready on this document yet */
    }
  }
  const cssPath = (start: Element): string => {
    const parts: string[] = []
    let node: Element | null = start
    while (node && node.nodeType === 1 && parts.length < 4) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      let sel = node.nodeName.toLowerCase()
      const parent: Element | null = node.parentElement
      if (parent) {
        const twins = Array.from(parent.children).filter((c) => c.nodeName === node!.nodeName)
        if (twins.length > 1) sel += `:nth-of-type(${twins.indexOf(node) + 1})`
      }
      parts.unshift(sel)
      node = parent
    }
    return parts.join(' > ')
  }
  const labelOf = (el: HTMLInputElement | HTMLTextAreaElement): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lab?.textContent) return lab.textContent
    }
    const wrap = el.closest('label')
    if (wrap?.textContent) return wrap.textContent
    return el.getAttribute('placeholder') ?? el.getAttribute('name') ?? ''
  }
  document.addEventListener(
    'click',
    (ev) => {
      const raw = ev.target
      if (!(raw instanceof Element)) return
      const el = raw.closest('a,button,[role="button"],input[type="submit"],input[type="button"],[onclick]') ?? raw
      send({ kind: 'click', css: cssPath(el), text: (el as HTMLElement).innerText?.trim().slice(0, 120) ?? '', walled: walled() })
    },
    true,
  )
  document.addEventListener(
    'change',
    (ev) => {
      const el = ev.target
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
      const secret = el instanceof HTMLInputElement && el.type === 'password'
      send({ kind: 'input', css: cssPath(el), text: labelOf(el).trim().slice(0, 120), value: secret ? '' : el.value, secret, walled: walled() })
    },
    true,
  )
}

// Starts fresh so the instrumentation cannot collide with a binding an earlier
// errand's context already carries; stopTeach tears the instrumented context
// down again so later errands get a clean one.
// Watching one tab is not watching the session: people open links in new
// tabs, and the tab that exists when recording starts has already loaded its
// document, so an init script alone would miss it.
function watchForTeach(page: Page): void {
  page.on('framenavigated', (frame) => {
    if (!teachEvents || frame !== page.mainFrame()) return
    const url = frame.url()
    if (url && url !== 'about:blank') teachEvents.push({ kind: 'nav', url })
  })
  // Instrument the document that is already on screen; the init script covers
  // every one after it.
  void page.evaluate(RECORDER).catch(() => undefined)
}

export async function startTeach(): Promise<void> {
  await closeAgentBrowser({ force: true })
  claimAgentBrowser(true)
  // Claimed BEFORE the window exists: from here on an unforced close is a
  // no-op, so a teardown still in flight cannot take the recording with it.
  const events: TeachEvent[] = []
  teachEvents = events
  const ctx = await agentContext()
  await ctx.exposeBinding('__engramTeach', (_source, payload: unknown) => {
    if (teachEvents && payload && typeof payload === 'object') teachEvents.push(payload as TeachEvent)
  })
  await ctx.addInitScript(RECORDER)
  releaseTeachHold = holdAgentBrowser()
  ctx.on('page', (opened) => {
    if (teachEvents) watchForTeach(opened)
  })
  const page = await agentPage()
  for (const open of ctx.pages()) watchForTeach(open)
  await page.goto('about:blank').catch(() => undefined)
}

export function markTeachRead(): void {
  if (!teachEvents) return
  // The last page the person touched is the one they mean — the tab a link
  // opened, not necessarily the tab the session started in.
  const live = agentPages()
  const page = live[live.length - 1] ?? agentWorkPage()
  if (page) teachEvents.push({ kind: 'read', url: page.url() })
}

export async function stopTeach(): Promise<TeachEvent[]> {
  const events = teachEvents ?? []
  teachEvents = null
  releaseTeachHold?.()
  releaseTeachHold = null
  claimAgentBrowser(false)
  await closeAgentBrowser({ force: true })
  return events
}

export function teaching(): boolean {
  return teachEvents !== null
}
