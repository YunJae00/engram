import type { PageMove, WebCourier } from 'core'
import { armIdleClose, agentAbortable as withAbort, DEFAULT_LANE, ensureAgentPage, NAV_TIMEOUT_MS, readPage } from './agent-browser.js'
import { routineDriver } from './routine-driver.js'
import { chooseOption, hoverOn, pressKey, pressOn, pressPoint, scrollPage, typeText, type Ask } from './page-actions.js'
import { revealText } from './page-reveal.js'
import { maskSecrets } from './page-mask.js'

// What a comet is given when it can reach the web: one browser, one reused
// tab, and the hands that move around a page without committing anything.
// It knows nothing at all about search engines - where to go is the caller's
// judgement, which is what lets it be sent somewhere new.

// A hand on a page answers within a budget, or answers that it did not: a
// page that swallows a click must not swallow the turn with it.
const HAND_BUDGET_MS = 45_000
function withinBudget(work: Promise<PageMove>): Promise<PageMove> {
  return Promise.race([
    work,
    new Promise<PageMove>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'the page did not answer that in time' }), HAND_BUDGET_MS).unref(),
    ),
  ])
}

// Two comets sharing one browser share its sign-ins - and so, on one site,
// its session. Reading side by side is fine; two hands changing the same
// site's page at the same moment is how one of them ends up filling a form
// the other just replaced. Changes on one host take turns; the host is all
// the rule knows.
const hostTurns = new Map<string, Promise<unknown>>()
async function inTurnOn(url: string, work: () => Promise<PageMove>): Promise<PageMove> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return work()
  }
  const before = hostTurns.get(host) ?? Promise.resolve()
  const mine = before.then(work, work)
  hostTurns.set(host, mine.catch(() => undefined))
  return mine
}

// One browser, one tab per lane. It knows how to open, read, type and click
// - and nothing at all about search engines: where to go is the caller's
// judgement, which is what lets it be sent somewhere new.
export function agentCourier(deps: { askBeforePress?: Ask; lane?: string; onLook?: (url: string, covered: number) => void } = {}): WebCourier {
  const ask = deps.askBeforePress
  const lane = deps.lane ?? DEFAULT_LANE
  const ensurePage = () => ensureAgentPage(lane)
  return {
    async readOpen(signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withAbort(readPage(page), signal)
    },
    async typeInto(field, text, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver().type({ text: field }, text, signal)
      void page
      return { ok: done.ok }
    },
    async clickOn(target, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver().click({ text: target }, signal)
      void page
      return { ok: done.ok }
    },
    async press(target, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(page.url(), () => withinBudget(pressOn(page, target, signal, ask)))
    },
    async typeText(target, text, enter, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(page.url(), () => withinBudget(typeText(page, target, text, enter, signal)))
    },
    async choose(target, option, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(page.url(), () => withinBudget(chooseOption(page, target, option, signal)))
    },
    async scroll(to, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(scrollPage(page, to, signal))
    },
    async hover(target, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(hoverOn(page, target, signal))
    },
    async pressKey(key, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(pressKey(page, key))
    },
    async reveal(word, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(revealText(page, word))
    },
    async pressPoint(x, y, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(page.url(), () => withinBudget(pressPoint(page, x, y, ask)))
    },
    async look(signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      // The visible part only, so a point on the picture is a point on the
      // page: the fractions a press is given mean the same thing to both.
      // The fields the page declares secret are covered for the picture,
      // and the picture is the one thing here that leaves for a brain, so
      // it is written down: where, and how many fields were covered.
      const masked = await maskSecrets(page).catch(() => null)
      const shot = await withAbort(page.screenshot({ type: 'jpeg', quality: 60, scale: 'css', fullPage: false }), signal).catch(() => null)
      await masked?.uncover().catch(() => undefined)
      if (shot) deps.onLook?.(page.url(), masked?.covered ?? 0)
      return shot ? { data: shot.toString('base64'), mimeType: 'image/jpeg' } : null
    },
    async fetchPage(url, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      await withAbort(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), signal)
      // JS-rendered pages paint just after domcontentloaded; a short settle
      // beats waiting for 'load' on ad-heavy pages that never finish.
      await page.waitForTimeout(800)
      let result = await withAbort(readPage(page), signal)
      // A page that draws itself after loading is given one more moment.
      if (result.text.trim().length < 40) {
        await page.waitForTimeout(2_000)
        result = await withAbort(readPage(page), signal)
      }
      armIdleClose()
      return result
    },
  }
}
