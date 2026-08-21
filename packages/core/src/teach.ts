import type { RoutineStep, RoutineTarget } from './routine.js'

// Teach mode records what a person actually does in the agent browser and
// turns it into a routine — so a non-developer authors a replay by doing the
// work once, never by naming a selector. The recording is raw events; this
// pure transform is where they become the steps the driver replays, and where
// the one rule that cannot bend lives: a login is the human's forever, so
// nothing typed on a page that holds a password is ever written down.

export type TeachEvent =
  | { kind: 'nav'; url: string }
  | { kind: 'click'; css?: string; text?: string; walled?: boolean }
  // `secret` is a password field; `walled` means a password field was present
  // anywhere on the page. Either drops the value on the floor.
  | { kind: 'input'; css?: string; text?: string; value: string; secret?: boolean; walled?: boolean }
  | { kind: 'read'; url: string }

const TARGET_TEXT_CAP = 120
const TYPE_TEXT_CAP = 500
const CSS_LEN_CAP = 300

function cleanTarget(ev: { css?: string; text?: string }): RoutineTarget | null {
  const out: RoutineTarget = {}
  const css = (ev.css ?? '').trim()
  if (css && css.length <= CSS_LEN_CAP) out.css = [css.slice(0, CSS_LEN_CAP)]
  const text = (ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, TARGET_TEXT_CAP)
  if (text) out.text = text
  if (!out.css && !out.text) return null
  return out
}

function sameTarget(a: RoutineTarget, b: RoutineTarget): boolean {
  return (a.css?.[0] ?? '') === (b.css?.[0] ?? '') && (a.text ?? '') === (b.text ?? '')
}

// Raw events → replayable steps. Navigations that a click caused are dropped
// (replaying the click navigates again); repeated edits of one field collapse
// to its final value; password / login-page input never survives.
export function buildRoutineFromTeach(events: TeachEvent[]): RoutineStep[] {
  const steps: RoutineStep[] = []
  let lastKind = ''
  for (const ev of events) {
    if (ev.kind === 'nav') {
      if (lastKind === 'click') {
        lastKind = 'nav-after-click'
        continue
      }
      const url = ev.url.trim()
      if (!/^https?:/i.test(url)) continue
      const prev = steps[steps.length - 1]
      if (prev && prev.kind === 'open' && prev.url === url) continue
      steps.push({ kind: 'open', url })
      lastKind = 'nav'
    } else if (ev.kind === 'click') {
      // A click on a walled page is part of signing in — the human's job at
      // replay time, never the routine's. Dropping it lets the page it leads
      // to register as its own open step.
      if (ev.walled) {
        lastKind = 'click-secret'
        continue
      }
      const target = cleanTarget(ev)
      if (!target) {
        lastKind = 'click-empty'
        continue
      }
      steps.push({ kind: 'click', target })
      lastKind = 'click'
    } else if (ev.kind === 'input') {
      // The unbending rule: a login is the person's alone. Anything typed on a
      // page bearing a password field, and every password field itself, is
      // dropped before it can be written down.
      if (ev.secret || ev.walled) {
        lastKind = 'input-secret'
        continue
      }
      const target = cleanTarget(ev)
      if (!target) {
        lastKind = 'input-empty'
        continue
      }
      const value = ev.value.slice(0, TYPE_TEXT_CAP)
      const prev = steps[steps.length - 1]
      if (prev && prev.kind === 'type' && sameTarget(prev.target, target)) prev.text = value
      else steps.push({ kind: 'type', target, text: value })
      lastKind = 'input'
    } else if (ev.kind === 'read') {
      const prev = steps[steps.length - 1]
      if (prev && prev.kind === 'read') continue
      steps.push({ kind: 'read' })
      lastKind = 'read'
    }
  }
  return steps
}
