export type GateMode = 'off' | 'on' | 'always'

export interface GateDecision { choice: string; confidence: number; probabilities?: Record<string, number> }

const CONTRAST_MARGIN = 0.3
const INSIST = 0.15
const ROLLBACKS = 2
const SURE = 0.8
const NO_GOAL = 0.05
const DONE_HINT = 0.15
const TERMINAL = new Set(['done', 'blocked'])

interface StepGate {
  readonly mode: GateMode
  arrive(state: string): void
  banned(state: string): string[]
  moved(state: string, choice: string, went: boolean, url: string, confidence: number): void
  doubtful(): boolean
  insist(state: string, decision: GateDecision): string | null
  rollback(decision?: GateDecision): string | null
  settleStop(state: string, decision: GateDecision): boolean
  contrast(decision: GateDecision): [string, string] | null
  doneCheck(decision: GateDecision, unsure: boolean): boolean
  settle(path: string, choice: string): boolean
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
      if (!on || decision.choice !== 'blocked' || (!failedAt.has(state) && !bans.get(state)?.size)) return null
      const best = ranked(decision).find(([choice]) => !TERMINAL.has(choice) && !bans.get(state)?.has(choice))
      return best && best[1] >= INSIST ? best[0] : null
    },
    doubtful: () => on && (trail.at(-1)?.confidence ?? 1) < SURE,
    rollback(decision) {
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
