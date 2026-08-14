import { beforeEach, describe, expect, it } from 'vitest'
import { readNudgeLedger, recordNudge, snoozeMultiplier, type NudgeEvent } from '../src/notifications.js'
import { initVault, type VaultPaths } from '../src/index.js'
import { tmpVaultRoot } from './helpers.js'

// M9-4: silence is an answer, and now it is a REMEMBERED answer. The ledger
// records every showing and what became of it; a card type the user keeps
// waving away earns a longer snooze. These tests pin the thresholds and the
// do-not-disturb boundaries.

let paths: VaultPaths
beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('notifications'), { git: false })
})

const event = (cardType: string, action: NudgeEvent['action']): NudgeEvent => ({
  at: '2026-07-31T12:00:00Z',
  cardType,
  action,
})

describe('the ledger', () => {
  it('round-trips events and survives a corrupt line', async () => {
    await recordNudge(paths, 'conflict', 'shown', new Date('2026-07-31T10:00:00Z'))
    await recordNudge(paths, 'conflict', 'later', new Date('2026-07-31T10:01:00Z'))
    const events = await readNudgeLedger(paths)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ cardType: 'conflict', action: 'shown' })
    // A torn write must not poison the history.
    const { appendFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await appendFile(join(paths.cache, 'nudge-ledger.jsonl'), '{"broken\n')
    await recordNudge(paths, 'brief', 'answered')
    expect((await readNudgeLedger(paths)).map((e) => e.cardType)).toEqual(['conflict', 'conflict', 'brief'])
  })
})

describe('snoozeMultiplier — ignoring a type quiets it', () => {
  it('answers keep the base cadence; light history holds no grudge', () => {
    expect(snoozeMultiplier([event('conflict', 'shown'), event('conflict', 'answered')], 'conflict')).toBe(1)
    expect(snoozeMultiplier([event('conflict', 'shown'), event('conflict', 'later')], 'conflict')).toBe(1)
  })

  it('waving away most showings doubles; nearly all of many showings goes to a day', () => {
    const mostly: NudgeEvent[] = []
    for (let i = 0; i < 4; i++) mostly.push(event('stale', 'shown'), event('stale', 'later'))
    mostly.push(event('stale', 'shown'), event('stale', 'answered'))
    expect(snoozeMultiplier(mostly, 'stale')).toBe(2)

    const always: NudgeEvent[] = []
    for (let i = 0; i < 6; i++) always.push(event('brief', 'shown'), event('brief', 'later'))
    expect(snoozeMultiplier(always, 'brief')).toBe(6)
    // The grudge is per type — conflicts are unaffected by brief fatigue.
    expect(snoozeMultiplier(always, 'conflict')).toBe(1)
  })
})

