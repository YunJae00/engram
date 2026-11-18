import { MockEngine } from './mock.js'
import type { Engine, EngineDetection, EngineId } from './types.js'

export const ENGINE_ORDER: EngineId[] = ['claude', 'codex']

export type CloudEngineId = 'claude' | 'codex'

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

type EngineBinaries = Partial<Record<EngineId, string>>

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
      if (known.has(id)) available.push(engine)
    }
  }
  return available
}
