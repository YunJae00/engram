import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { trimJsonlIfHuge } from './receipts.js'
import { dirname, join } from 'node:path'
import type { VaultPaths } from './vault.js'

// M9-4 — the notification ledger, and the discipline it buys: SILENCE IS AN
// ANSWER. Every floating card the nudge shows is recorded with what happened
// to it (answered, or waved away with "later"), and a card TYPE the user
// keeps waving away starts asking less often — snooze doubling to 8h, then
// 24h. No settings page, no toggle: the user already answered by ignoring it,
// and a prompt that cannot learn that is a prompt people learn to click away
// blindly (nudge.ts rule 3, now with memory).
//
// A jsonl ledger, not frontmatter: these are app-behaviour events, not
// memories — they never enter the vault's notes, views or sync.

export type NudgeAction = 'shown' | 'answered' | 'later' | 'copied'

export interface NudgeEvent {
  at: string
  cardType: string
  action: NudgeAction
}

const LEDGER = 'nudge-ledger.jsonl'
// Judge on recent behaviour only — the user who ignored stale cards all of
// March may care in July.
const WINDOW = 30

function ledgerFile(paths: VaultPaths): string {
  return join(paths.cache, LEDGER)
}

export async function recordNudge(paths: VaultPaths, cardType: string, action: NudgeAction, now: Date = new Date()): Promise<void> {
  const line = `${JSON.stringify({ at: now.toISOString(), cardType, action } satisfies NudgeEvent)}\n`
  await mkdir(dirname(ledgerFile(paths)), { recursive: true }).catch(() => undefined)
  await appendFile(ledgerFile(paths), line).catch(() => undefined)
  await trimJsonlIfHuge(ledgerFile(paths))
}

export async function readNudgeLedger(paths: VaultPaths): Promise<NudgeEvent[]> {
  try {
    const raw = await readFile(ledgerFile(paths), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as NudgeEvent
        } catch {
          return null
        }
      })
      .filter((e): e is NudgeEvent => e !== null && typeof e.cardType === 'string')
  } catch {
    return []
  }
}

// How much longer than the base snooze this card type should stay quiet after
// a "later", judged on its recent record: answering keeps the multiplier at
// 1; waving away most of the last WINDOW showings doubles it; waving away
// nearly all of them (and at least five) sends it to a day.
export function snoozeMultiplier(events: NudgeEvent[], cardType: string): number {
  const recent = events.filter((e) => e.cardType === cardType).slice(-WINDOW)
  const shown = recent.filter((e) => e.action === 'shown').length
  const later = recent.filter((e) => e.action === 'later').length
  if (shown < 3) return 1 // too little history to hold a grudge
  const ignoreRate = later / shown
  if (ignoreRate >= 0.9 && later >= 5) return 6 // 4h → 24h
  if (ignoreRate >= 0.6) return 2 // 4h → 8h
  return 1
}
