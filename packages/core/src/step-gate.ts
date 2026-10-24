// A gate on each step of a page run: before a pick is made it is let
// through, checked, or the run first goes back on what already failed. It
// spends extra decisions only where a run tends to go wrong - a pick that
// returns it to a page it already left, a move that would not go through, two
// picks too close to call, a stop with the goal possibly met, a repeat that
// may only be the page still loading - and nothing on a clear path.
//
// off: no gate. on: checks only at those risks. always: every check at every
// step, the most it can cost.
export type GateMode = 'off' | 'on' | 'always'

export interface GateDecision { choice: string; confidence: number; probabilities?: Record<string, number> }

// Two picks closer than this are worth a second look.
export const CONTRAST_MARGIN = 0.3
// A way left untried is worth this much belief before a stop gives it up.
const INSIST = 0.15
// How often a run goes back from a dead end.
const ROLLBACKS = 2
// A pick this sure of itself is not second-guessed where it led, while the page there might be the goal.
const SURE = 0.8
// Below this belief that the goal is met, a page is no goal at all.
const NO_GOAL = 0.05
// A stop with this much belief that the goal is already met is checked.
const DONE_HINT = 0.15
const TERMINAL = new Set(['done', 'blocked'])

export interface StepGate {
  readonly mode: GateMode
  // A page reached: back on one already left means what was done from it led nowhere.
  arrive(state: string): void
  // Picks not to offer on this page again.
  banned(state: string): string[]
  // What came of a pick made on a page, where that page was, and how sure the pick was.
  moved(state: string, choice: string, went: boolean, url: string, confidence: number): void
  // Whether the page now open was reached by a pick that was not sure of itself.
  doubtful(): boolean
  // A stop right after a move that would not go through: the best way left, if there is one.
  insist(state: string, decision: GateDecision): string | null
  // A dead end: where to go back to, with the pick that led here barred there.
  rollback(decision?: GateDecision): string | null
  // Whether a stop on a page just reached should wait a moment first: the page may still be loading.
  settleStop(state: string, decision: GateDecision): boolean
  // The two picks to compare before acting, when they are close.
  contrast(decision: GateDecision): [string, string] | null
  // Whether a stop should first ask if the goal is already met.
  doneCheck(decision: GateDecision, unsure: boolean): boolean
  // Whether to let the page settle before this pick: a repeat of one just made where the page is.
  settle(path: string, choice: string): boolean
  // A pick made, for spotting repeats.
  made(path: string, choice: string): void
}

const ranked = (decision: GateDecision): [string, number][] =>
  Object.entries(decision.probabilities ?? { [decision.choice]: decision.confidence }).sort((a, b) => b[1] - a[1])

export function stepGate(mode: GateMode, tuning: { margin?: number } = {}): StepGate {
  const on = mode !== 'off'
  const margin = tuning.margin ?? CONTRAST_MARGIN
  const trail: { state: string; choice: string; url: string; confidence: number }[] = []
  const failedAt = new Set<string>()
  let rolledBack = 0
  const waitedOn = new Set<string>()
  const seen = new Set<string>()
  const taken = new Map<string, Set<string>>()
  const bans = new Map<string, Set<string>>()
  const recent: { path: string; choice: string }[] = []
  const add = (map: Map<string, Set<string>>, state: string, choice: string) => map.set(state, new Set([...(map.get(state) ?? []), choice]))
  return {
    mode,
    arrive(state) {
      if (on && seen.has(state)) for (const choice of taken.get(state) ?? []) add(bans, state, choice)
      seen.add(state)
    },
    banned: state => (on ? [...(bans.get(state) ?? [])] : []),
    moved(state, choice, went, url, confidence) {
      if (!on) return
      add(taken, state, choice)
      if (went) trail.push({ state, choice, url, confidence })
      else { add(bans, state, choice); failedAt.add(state) }
    },
    insist(state, decision) {
      // A page that already cost a failure - a move that would not go through, or a way that led back here - is not given up on while a way is left.
      if (!on || decision.choice !== 'blocked' || (!failedAt.has(state) && !bans.get(state)?.size)) return null
      const best = ranked(decision).find(([choice]) => !TERMINAL.has(choice) && !bans.get(state)?.has(choice))
      return best && best[1] >= INSIST ? best[0] : null
    },
    doubtful: () => on && (trail.at(-1)?.confidence ?? 1) < SURE,
    rollback(decision) {
      // From where an unsure pick led, or a sure one led to a page with no sign of the goal.
      const last = trail.at(-1)
      const undo = !!last && (last.confidence < SURE || (decision?.probabilities?.['done'] ?? 1) < NO_GOAL)
      const back = on && rolledBack < ROLLBACKS && undo ? trail.pop() : undefined
      if (!back) return null
      rolledBack++
      add(bans, back.state, back.choice)
      return back.url
    },
    settleStop(state, decision) {
      if (!on || decision.choice === 'done' || waitedOn.has(state) || !trail.length) return false
      waitedOn.add(state)
      return decision.choice === 'blocked' || decision.confidence < 0.4
    },
    contrast(decision) {
      if (!on || TERMINAL.has(decision.choice)) return null
      const acts = ranked(decision).filter(([choice]) => !TERMINAL.has(choice))
      if (acts.length < 2) return null
      return mode === 'always' || acts[0]![1] - acts[1]![1] < margin ? [acts[0]![0], acts[1]![0]] : null
    },
    doneCheck(decision, unsure) {
      if (!on || decision.choice === 'done') return false
      const done = decision.probabilities?.['done'] ?? 0
      if (mode === 'always') return done > 0 || decision.choice === 'blocked' || unsure
      return (decision.choice === 'blocked' || unsure) && done >= DONE_HINT
    },
    settle(path, choice) {
      if (!on || TERMINAL.has(choice)) return false
      return mode === 'always' || recent.slice(-2).some(one => one.path === path && one.choice === choice)
    },
    made(path, choice) {
      recent.push({ path, choice })
      if (recent.length > 4) recent.shift()
    },
  }
}
