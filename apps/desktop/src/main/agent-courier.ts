import { net } from 'electron'
import { markNewControls, type PageMove, type WebCourier, type WebPage } from 'core'
import { armIdleClose, agentAbortable as withAbort, DEFAULT_LANE, ensureAgentPage, laneLastUrl, lanePage, NAV_TIMEOUT_MS, readPage } from './agent-browser.js'
import { routineDriver } from './routine-driver.js'
import { chooseOption, hoverOn, pressKey, pressOn, pressPoint, scrollPage, typeText, type Ask } from './page-actions.js'
import { revealText } from './page-reveal.js'
import { maskSecrets } from './page-mask.js'
import { touchedAt } from './agent-view.js'
import { readWhenReady } from './page-ready.js'
import { flog } from './flog.js'

const SLOW_OPEN_MS = 5_000

// What a comet is given when it can reach the web: one browser, one reused
// tab, and the hands that move around a page without committing anything.
// It knows nothing at all about search engines - where to go is the caller's
// judgement, which is what lets it be sent somewhere new.

// A hand on a page answers within a budget, or answers that it did not: a
// page that swallows a click must not swallow the turn with it.
const HAND_BUDGET_MS = 45_000
// A person deciding whether a press may go is not the page being slow: while
// `held` hands back their pending answer, the budget waits for it and starts over.
function withinBudget(work: Promise<PageMove>, awaitCompletion = false, held?: () => Promise<unknown> | null): Promise<PageMove> {
  if (awaitCompletion) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  return new Promise<PageMove>((resolve, reject) => {
    const arm = (): void => {
      if (settled) return
      timer = setTimeout(() => {
        const waiting = held?.()
        if (waiting) void waiting.then(arm, arm)
        else resolve({ ok: false, error: 'the page did not answer that in time' })
      }, HAND_BUDGET_MS).unref()
    }
    arm()
    work.then(resolve, reject)
  }).finally(() => { settled = true; clearTimeout(timer) })
}

// Changes to one conversation's site take turns without blocking other chats.
const hostTurns = new Map<string, Promise<unknown>>()
async function inTurnOn(lane: string, url: string, work: () => Promise<PageMove>, signal?: AbortSignal): Promise<PageMove> {
  signal?.throwIfAborted()
  let host: string
  try { host = new URL(url).host } catch { return work() }
  const key = JSON.stringify([lane, host])
  const before = hostTurns.get(key) ?? Promise.resolve()
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined
  let cancel: () => void = () => {}
  const waiting = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('This conversation is still using this site. The queued action did not start within 30 seconds. Read the page before trying again.')) }, 30_000)
    cancel = () => { expired = true; reject(signal?.reason ?? new Error('canceled')) }
    signal?.addEventListener('abort', cancel, { once: true })
  })
  const run = () => {
    clearTimeout(timer)
    signal?.throwIfAborted()
    if (expired) throw new Error('The queued browser action expired without running.')
    return work()
  }
  const mine = before.then(run, run)
  const tail = mine.catch(() => undefined).finally(() => { if (hostTurns.get(key) === tail) hostTurns.delete(key) })
  hostTurns.set(key, tail)
  try { return await Promise.race([mine, waiting]) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

// One browser, one tab per lane. It knows how to open, read, type and click
// - and nothing at all about search engines: where to go is the caller's
// judgement, which is what lets it be sent somewhere new.
// A colleague whose page you have just put your hands on does not keep
// pressing things under them. Every hand below first waits for the person's
// hands to have been still for a moment - reading never waits - and says
// so once on the way in and once on the way back.
const HANDS_STILL_MS = 4_000
const ASIDE_AT_MOST_MS = 5 * 60_000

async function stepAside(lane: string, signal: AbortSignal | undefined, say?: (phase: 'aside' | 'resume') => void): Promise<void> {
  if (Date.now() - touchedAt(lane) >= HANDS_STILL_MS) return
  say?.('aside')
  const from = Date.now()
  while (Date.now() - touchedAt(lane) < HANDS_STILL_MS && Date.now() - from < ASIDE_AT_MOST_MS) {
    if (signal?.aborted) throw new Error('stopped')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  say?.('resume')
}

export function agentCourier(
  deps: { askBeforePress?: Ask; lane?: string; awaitCompletion?: boolean; onLook?: (url: string, covered: number) => void; onAside?: (phase: 'aside' | 'resume') => void } = {},
): WebCourier {
  const ask = deps.askBeforePress
  const lane = deps.lane ?? DEFAULT_LANE
  const ensurePage = () => ensureAgentPage(lane)
  const aside = (signal?: AbortSignal) => stepAside(lane, signal, deps.onAside)
  // The controls of the last reading of each page, so the next reading can mark what is new.
  let seen: { at: string; names: Set<string> } | null = null
  const placeOf = (url: string) => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname } catch { return url } }
  const markReading = (read: WebPage): WebPage => {
    if (!read.controls?.length) { seen = null; return read }
    const at = placeOf(read.url)
    const marked = markNewControls(read.controls, seen?.at === at ? seen.names : undefined)
    seen = { at, names: marked.names }
    return { ...read, controls: marked.controls }
  }
  return {
    async readOpen(signal) {
      if (!lanePage(lane) && laneLastUrl(lane))
        throw new Error('This conversation\'s browser has closed. Use open_page to reopen the relevant address, then read_open_page. Do not treat a new blank tab as the previous page or switch to computer use because it closed.')
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const read = await withAbort(readWhenReady(page, reading => readPage(page, reading), signal), signal)
      return markReading(read)
    },
    async typeInto(field, text, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver(lane).type({ text: field }, text, signal)
      void page
      return { ok: done.ok }
    },
    async clickOn(target, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver(lane).click({ text: target }, signal)
      void page
      return { ok: done.ok }
    },
    async press(target, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      // The press is bounded like every hand, except while the person is
      // answering whether it may go.
      let asking: Promise<unknown> | null = null
      const held: typeof ask = ask && Object.assign((what: Parameters<typeof ask>[0]) => { const answer = ask(what); asking = answer; return answer.finally(() => { asking = null }) }, ask.reading ? { reading: ask.reading } : {})
      return inTurnOn(lane, page.url(), () => withinBudget(pressOn(page, target, signal, held), deps.awaitCompletion, () => asking), signal)
    },
    async typeText(target, text, enter, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(lane, page.url(), () => withinBudget(typeText(page, target, text, enter, signal), deps.awaitCompletion), signal)
    },
    async choose(target, option, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(lane, page.url(), () => withinBudget(chooseOption(page, target, option, signal, ask), deps.awaitCompletion), signal)
    },
    async scroll(to, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(scrollPage(page, to, signal), deps.awaitCompletion)
    },
    async hover(target, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(hoverOn(page, target, signal), deps.awaitCompletion)
    },
    async pressKey(key, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(pressKey(page, key, signal, ask), deps.awaitCompletion)
    },
    async reveal(word, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withinBudget(revealText(page, word), deps.awaitCompletion)
    },
    async pressPoint(x, y, signal) {
      await aside(signal)
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return inTurnOn(lane, page.url(), () => pressPoint(page, x, y, ask, signal), signal)
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
    // net.fetch with a manual redirect throws instead of answering with the
    // redirect, so the request is stopped at its first hop and read there.
    followRedirect(url, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) { resolve(null); return }
        const request = net.request({ url, redirect: 'manual' })
        const done = (target: string | null) => { signal?.removeEventListener('abort', stop); resolve(target); request.abort() }
        const stop = () => done(null)
        signal?.addEventListener('abort', stop, { once: true })
        request.on('redirect', (_status, _method, target) => { try { done(new URL(target, url).href) } catch { done(null) } })
        request.on('response', () => done(null))
        request.on('error', () => done(null))
        request.end()
      })
    },
    async fetchPage(url, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      // A slow open is logged with where the time went: a page can answer at once and still
      // hold its loaded event behind a third-party script that never responds.
      const started = performance.now()
      const response = await withAbort(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), signal)
      const status = response?.status() ?? 0
      const loaded = performance.now()
      const result = await withAbort(readWhenReady(page, reading => readPage(page, reading), signal), signal)
      const read = performance.now()
      if (read - started > SLOW_OPEN_MS) flog('browser', `slow open ${new URL(url).host}: loaded ${Math.round(loaded - started)}ms, read ${Math.round(read - loaded)}ms`)
      armIdleClose()
      const reading = markReading(result)
      return { ...reading, requestedUrl: url, ...(status >= 400 ? { status } : {}) }
    },
  }
}
