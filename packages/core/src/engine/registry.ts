import { MockEngine } from './mock.js'
import type { Engine, EngineDetection, EngineId } from './types.js'

// Two brains, each signed in to with the person's own plan and paid for by
// them. Nothing here switches between them behind the person's back - the one
// they chose is the one that answers, and a brain that is not signed in says
// so rather than handing the work to another.
export const ENGINE_ORDER: EngineId[] = ['claude', 'codex']

export type CloudEngineId = 'claude' | 'codex'

// The brains run the vendors' own runtimes, which only the host app carries.
// Injected once at boot; absent, an id reads as not installed.
let cloudFactory: ((id: CloudEngineId) => Engine | null) | null = null
export function setCloudEngineFactory(factory: (id: CloudEngineId) => Engine | null): void {
  cloudFactory = factory
}

function absentEngine(id: CloudEngineId): Engine {
  return {
    id,
    async detect(): Promise<EngineDetection> {
      return { installed: false, loggedIn: false, conclusive: true }
    },
    async *run() {
      yield { type: 'error' as const, message: `${id} is not part of this build`, kind: 'crash' as const }
    },
  }
}

export type EngineBinaries = Partial<Record<EngineId, string>>

export function createEngine(id: EngineId, binary?: string): Engine {
  void binary
  switch (id) {
    case 'claude':
    case 'codex':
      return cloudFactory?.(id) ?? absentEngine(id)
    case 'mock':
      return new MockEngine()
  }
}

// Every engine with what detection actually found — including the state that
// matters most during setup, "installed but not logged in". detectAvailable
// collapses that into absence, which left onboarding unable to say "you're one
// login away" and instead showing nothing at all.
export async function detectEngineStates(
  binaries: EngineBinaries = {},
): Promise<{ id: EngineId; installed: boolean; loggedIn: boolean }[]> {
  const states = []
  for (const id of ENGINE_ORDER) {
    try {
      const { installed, loggedIn } = await createEngine(id, binaries[id]).detect()
      states.push({ id, installed, loggedIn })
    } catch {
      states.push({ id, installed: false, loggedIn: false })
    }
  }
  return states
}

// Engines usable right now, default engine first.
//
// `keep` is the ids that were usable a moment ago. Detection re-runs every ten
// minutes for the life of the process, so the interesting case is not the first
// answer but the thousandth: a probe that times out, or an adapter that throws,
// tells us NOTHING about the engine — and dropping it on that non-answer is
// what users experience as Claude disconnecting on its own. An engine in `keep`
// therefore survives an inconclusive round and only leaves when detection
// positively reports it unusable.
//
// A first, unknown engine is still excluded on a non-answer: absent evidence,
// "not ready yet" is the honest state, and the next round adds it.
// The whole policy as one pure function, so it is testable without spawning —
// same shape as resolveLoggedIn in claude.ts, and for the same reason: this is
// the line that decides whether a user sees "no engine".
//   usable now                  → in, whatever the history
//   definitely unusable         → out, whatever the history
//   we could not tell + known   → in (a non-answer retires nothing)
//   we could not tell + unknown → out (absent evidence, not "ready")
export function keepsEngine(detection: EngineDetection, wasKnown: boolean): boolean {
  if (detection.installed && detection.loggedIn) return true
  return detection.conclusive === false && wasKnown
}

export async function detectAvailableEngines(
  defaultEngine: EngineId = 'claude',
  binaries: EngineBinaries = {},
  keep: Iterable<EngineId> = [],
): Promise<Engine[]> {
  const order = [defaultEngine, ...ENGINE_ORDER.filter((id) => id !== defaultEngine)]
  const known = new Set(keep)
  const available: Engine[] = []
  for (const id of order) {
    const engine = createEngine(id, binaries[id])
    try {
      if (keepsEngine(await engine.detect(), known.has(id))) available.push(engine)
    } catch {
      // The adapter itself failed — also a non-answer, not a verdict.
      if (known.has(id)) available.push(engine)
    }
  }
  return available
}
