import { pressCommits, type PressTarget, type RoutineDriver, type RoutineReading, type RoutineStepResult, type RoutineTarget } from 'core'
import { agentAbortable, agentPage, readAgentPage, agentWorkPage } from './agent-browser.js'

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
const SETTLE_MS = 800

export type TargetProbe =
  | { via: 'css'; css: string }
  | { via: 'role-button' | 'role-link' | 'label' | 'placeholder' | 'role-textbox' | 'text'; text: string }

// Ordered fallbacks for one target, saved selectors first: CSS is precise
// until a redesign, the visible words usually survive one. Pure for its test.
export function targetPlan(target: RoutineTarget, purpose: 'click' | 'type'): TargetProbe[] {
  const probes: TargetProbe[] = []
  for (const css of target.css ?? []) if (css.trim()) probes.push({ via: 'css', css: css.trim() })
  const text = target.text?.trim()
  if (text) {
    if (purpose === 'click') probes.push({ via: 'role-button', text }, { via: 'role-link', text }, { via: 'text', text })
    else probes.push({ via: 'label', text }, { via: 'placeholder', text }, { via: 'role-textbox', text })
  }
  return probes
}

export function describeTarget(target: RoutineTarget): string {
  return target.text?.trim() || target.css?.[0] || 'the element'
}

function toLocator(page: Page, probe: TargetProbe): Locator {
  switch (probe.via) {
    case 'css':
      return page.locator(probe.css).first()
    case 'role-button':
      return page.getByRole('button', { name: probe.text }).first()
    case 'role-link':
      return page.getByRole('link', { name: probe.text }).first()
    case 'text':
      return page.getByText(probe.text, { exact: false }).first()
    case 'label':
      return page.getByLabel(probe.text).first()
    case 'placeholder':
      return page.getByPlaceholder(probe.text).first()
    case 'role-textbox':
      return page.getByRole('textbox', { name: probe.text }).first()
  }
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
  for (const probe of targetPlan(target, purpose)) {
    if (signal?.aborted) throw new Error('canceled')
    try {
      await agentAbortable(run(toLocator(page, probe)), signal)
      await settle(page)
      const wall = await wallOf(page, signal)
      return wall ? { ok: true, wall } : { ok: true }
    } catch (err) {
      if (err instanceof Error && err.message === 'canceled') throw err
      // try the next fallback
    }
  }
  // The step failed, but WHY matters to the person: a login page swallowing
  // the whole portal is the usual reason a saved button is suddenly gone.
  const wall = await wallOf(page, signal)
  if (wall) return { ok: false, wall }
  return { ok: false, error: `could not find "${describeTarget(target)}" on the page` }
}

// What a control is, read off the page before it is pressed: whether it
// submits a form by its shape, and the words on it. Runs inside the page.
function inspectControl(node: Element): PressTarget {
  const el = node.closest('a,button,input,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"]') ?? node
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  const inForm = el.closest('form') !== null
  const submits = (tag === 'button' && inForm && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image'))
  const words = [(el as HTMLElement).innerText ?? el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('value') ?? '', el.getAttribute('title') ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { submits, words }
}

// A press that only moves around the page. The control is looked at first
// and a press that would commit something is refused before it happens.
export async function pressOn(page: Page, text: string, signal?: AbortSignal): Promise<{ ok: boolean; refused?: string; error?: string }> {
  for (const probe of targetPlan({ text }, 'click')) {
    if (signal?.aborted) throw new Error('canceled')
    const locator = toLocator(page, probe)
    let control: PressTarget
    try {
      control = await agentAbortable(locator.evaluate(inspectControl, undefined, { timeout: FIND_TIMEOUT_MS }), signal)
    } catch (err) {
      if (err instanceof Error && err.message === 'canceled') throw err
      continue
    }
    if (pressCommits(control)) return { ok: false, refused: control.words.slice(0, 80) }
    try {
      await agentAbortable(locator.click({ timeout: FIND_TIMEOUT_MS }), signal)
      await settle(page)
      return { ok: true }
    } catch (err) {
      if (err instanceof Error && err.message === 'canceled') throw err
    }
  }
  return { ok: false, error: `could not find "${text}" on the page` }
}

export function routineDriver(): RoutineDriver {
  return {
    location: () => agentWorkPage()?.url() ?? null,
    async open(url, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal)
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
      const page = await agentPage(signal)
      return act(page, target, 'click', (locator) => locator.click({ timeout: FIND_TIMEOUT_MS }), signal)
    },
    async type(target, text, signal): Promise<RoutineStepResult> {
      const page = await agentPage(signal)
      return act(page, target, 'type', (locator) => locator.fill(text, { timeout: FIND_TIMEOUT_MS }), signal)
    },
    async read(signal): Promise<RoutineReading & { wall?: 'login' | 'captcha' }> {
      const page = await agentPage(signal)
      const reading = await readAgentPage(page, signal)
      return { url: reading.url, title: reading.title, text: reading.text, ...(reading.wall ? { wall: reading.wall } : {}) }
    },
  }
}
