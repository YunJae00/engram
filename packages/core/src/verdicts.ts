import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { trimJsonlIfHuge } from './receipts.js'
import { dirname, join } from 'node:path'
import type { VaultPaths } from './vault.js'

export type CardVerdictKind = 'approved' | 'rejected' | 'edited' | 'answered-in-text'
export type VerdictActor = 'user' | 'librarian'

export interface CardVerdictEvent {
  at: string
  cardId: string
  cardType: string
  job?: string
  verdict: CardVerdictKind
  actor: VerdictActor
  choice?: string
  reason?: string
}

const LEDGER = 'verdict-ledger.jsonl'

export async function recordVerdict(paths: VaultPaths, event: Omit<CardVerdictEvent, 'at'>, now: Date = new Date()): Promise<void> {
  const file = join(paths.cache, LEDGER)
  const line = `${JSON.stringify({ at: now.toISOString(), ...event } satisfies CardVerdictEvent)}\n`
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await appendFile(file, line).catch(() => undefined)
  await trimJsonlIfHuge(file)
}

export async function readVerdictLedger(paths: VaultPaths): Promise<CardVerdictEvent[]> {
  try {
    const raw = await readFile(join(paths.cache, LEDGER), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as CardVerdictEvent
        } catch {
          return null
        }
      })
      .filter((e): e is CardVerdictEvent => e !== null && typeof e.cardId === 'string')
  } catch {
    return []
  }
}
