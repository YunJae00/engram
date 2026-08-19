import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendErrandRecord, readErrandJournal, type ErrandRecord } from '../src/errand-journal.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const record = (n: number, overrides: Partial<ErrandRecord> = {}): ErrandRecord => ({
  id: `run-${n}`,
  goal: `goal ${n}`,
  startedAt: new Date(1_700_000_000_000 + n * 60_000).toISOString(),
  endedAt: new Date(1_700_000_000_000 + n * 60_000 + 30_000).toISOString(),
  outcome: 'done',
  noteSources: n,
  pages: [],
  ...overrides,
})

describe('errand journal — the delegation is auditable afterwards', () => {
  it('newest run first, fields intact', async () => {
    const paths = await initVault(await tmpVaultRoot('errand-journal'), { git: false })
    await appendErrandRecord(paths, record(1))
    await appendErrandRecord(paths, record(2, { outcome: 'failed', error: 'no usable queries' }))
    const rows = await readErrandJournal(paths)
    expect(rows.map((r) => r.id)).toEqual(['run-2', 'run-1'])
    expect(rows[0]).toMatchObject({ outcome: 'failed', error: 'no usable queries' })
  })

  it('an empty vault has an empty history, not an error', async () => {
    const paths = await initVault(await tmpVaultRoot('errand-journal-empty'), { git: false })
    expect(await readErrandJournal(paths)).toEqual([])
  })

  it('a corrupt line costs itself, not the whole history', async () => {
    const paths = await initVault(await tmpVaultRoot('errand-journal-corrupt'), { git: false })
    await appendErrandRecord(paths, record(1))
    await appendFile(join(paths.cache, 'errands.jsonl'), 'not json at all\n')
    await appendErrandRecord(paths, record(2))
    const rows = await readErrandJournal(paths)
    expect(rows.map((r) => r.id)).toEqual(['run-2', 'run-1'])
  })

  it('history is capped — the hundredth-and-first run pushes the oldest out', async () => {
    const paths = await initVault(await tmpVaultRoot('errand-journal-cap'), { git: false })
    for (let n = 0; n < 101; n++) await appendErrandRecord(paths, record(n))
    const rows = await readErrandJournal(paths)
    expect(rows).toHaveLength(100)
    expect(rows[0]!.id).toBe('run-100')
    expect(rows.at(-1)!.id).toBe('run-1')
  })
})
