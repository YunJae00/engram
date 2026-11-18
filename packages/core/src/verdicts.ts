import { appendFile, mkdir } from 'node:fs/promises'
import { trimJsonlIfHuge } from './receipts.js'
import { dirname, join } from 'node:path'
import type { VaultPaths } from './vault.js'

type CardVerdictKind = 'approved' | 'rejected' | 'edited' | 'answered-in-text'
export type VerdictActor = 'user' | 'librarian'

interface CardVerdictEvent {
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

