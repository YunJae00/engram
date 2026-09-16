import type { RoutineDriver, RoutineReading, RoutineStepResult, RoutineTarget } from 'core'
import { handOn, pressKey } from './page-actions.js'
import { agentAbortable, agentPage, readAgentPage, DEFAULT_LANE, lanePage } from './agent-browser.js'

// The routine's hands: the same agent Chrome the errand courier drives, so a
// login the user performed for either survives for both. Every operation
// ends with a wall probe — a portal that bounced to its SSO page mid-routine
// must surface as "needs a person", never as a mysterious missing button.

type Page = import('playwright-core').Page
type Locator = import('playwright-core').Locator

const NAV_TIMEOUT_MS = 25_000
// Per candidate selector: long enough for a slow render, short enough that a
// step with several fallbacks still fails inside a person's patience.
const FIND_TIMEOUT_MS = 3_000
const SETTLE_MS = 300

export function describeTarget(target: RoutineTarget): string {
  return target.text?.trim() || target.css?.[0] || 'the element'
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS)
}

async function wallOf(page: Page, signal?: AbortSignal): Promise<'login' | 'captcha' | undefined> {
  const reading = await readAgentPage(page, signal).catch(() => null)
  return reading?.wall
}

async function act(
  page: Page,
  target: RoutineTarget,
  purpose: 'click' | 'type',
  run: (locator: Locator) => Promise<void>,
  signal?: AbortSignal,
): Promise<RoutineStepResult> {
  const deadline = Date.now() + FIND_TIMEOUT_MS
  do {
    if (signal?.aborted) throw new Error('canceled')
    const aim = await handOn(page, target.text?.trim() ?? '', signal, target.css)
    if ('many' in aim) return { ok: false, recoverable: true, error: `more than one visible control matches "${describeTarget(target)}"` }
    if ('none' in aim) {
      await page.waitForTimeout(150)
      continue
    }
    try {
      if (signal?.aborted) throw new Error('canceled')
      await agentAbortable(run(aim.hand), signal)
      await settle(page)
      const wall = await wallOf(page, signal)
      return wall ? { ok: true, wall } : { ok: true }
    } catch (err) {
      if (err instanceof Error && err.message === 'canceled') throw err
      return { ok: false, error: `could not ${purpose} "${describeTarget(target)}": ${err instanceof Error ? err.message : String(err)}` }
    }
  } while (Date.now() < deadline)
  // The step failed, but WHY matters to the person: a login page swallowing
  // the whole portal is the usual reason a saved button is suddenly gone.
  const wall = await wallOf(page, signal)
  if (wall) return { ok: false, wall }
  return { ok: false, recoverable: true, error: `could not find "${describeTarget(target)}" on the page` }
}

// One driver per lane: a replay run for a comet drives that comet's own
// tab, so two comets can each be mid-procedure without taking each other's
// page. Scheduled runs use the shared default.
export function routineDriver(lane: string = DEFAULT_LANE): RoutineDriver {
  return {
    location: () => lanePage(lane)?.url() ?? null,
    async open(url, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal, lane)
      try {
        await agentAbortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), signal)
      } catch (err) {
        if (err instanceof Error && err.message === 'canceled') throw err
        let host = url
        try {
          host = new URL(url).hostname
        } catch {
          /* keep the raw url */
        }
        return { ok: false, error: `${host} did not answer in time` }
      }
      await settle(page)
      const wall = await wallOf(page, signal)
      return wall ? { ok: true, wall } : { ok: true }
    },
    async click(target, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal, lane)
      return act(page, target, 'click', (locator) => locator.click({ timeout: FIND_TIMEOUT_MS }), signal)
    },
    async type(target, text, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal, lane)
      return act(page, target, 'type', (locator) => locator.fill(text, { timeout: FIND_TIMEOUT_MS }), signal)
    },
    async key(key, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal, lane)
      try {
        const result = await agentAbortable(pressKey(page, key, signal), signal)
        if (!result.ok) return { ok: false, error: result.refused ?? result.error ?? `could not press ${key}` }
        const wall = await wallOf(page, signal)
        return wall ? { ok: true, wall } : { ok: true }
      } catch (err) {
        if (err instanceof Error && err.message === 'canceled') throw err
        return { ok: false, error: `could not press ${key}` }
      }
    },
    async read(signal): Promise<RoutineReading & { wall?: 'login' | 'captcha' }> {
      const page = await agentPage(signal, lane)
      const reading = await readAgentPage(page, signal)
      return { url: reading.url, title: reading.title, text: reading.text, ...(reading.wall ? { wall: reading.wall } : {}) }
    },
  }
}
