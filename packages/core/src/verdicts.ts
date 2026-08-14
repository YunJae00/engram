import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { trimJsonlIfHuge } from './receipts.js'
import { dirname, join } from 'node:path'
import type { VaultPaths } from './vault.js'

// The verdict ledger: every card resolution, written down as it happens.
//
// Dogfooding's most perishable output is the stream of judgments the user
// makes in review — approve, reject, rewrite — and until now each one was
// consumed and discarded. Recorded, they become the raw material for a
// librarian style guide: after a few hundred verdicts the patterns in what
// gets rejected ("stop raising supersede cards for X") can be distilled into
// the job prompts, the same way the notification ledger already teaches the
// nudge WHEN to ask. This file only records; the distillation comes when the
// data has earned it.
//
// Actor matters: the librarian resolves its own machine-vs-machine cards
// (J12), and those verdicts are not training signal about the USER's taste —
// they are stamped 'librarian' so the distillation can filter them out.

export type CardVerdictKind = 'approved' | 'rejected' | 'edited' | 'answered-in-text'
export type VerdictActor = 'user' | 'librarian'

export interface CardVerdictEvent {
  at: string
  cardId: string
  cardType: string
  job?: string
  verdict: CardVerdictKind
  actor: VerdictActor
  // conflict approvals: which side won (A/B/both)
  choice?: string
  // rejections: the reason the caller recorded
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
