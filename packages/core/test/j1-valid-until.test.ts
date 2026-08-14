import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { freshnessOf } from '../src/freshness.js'
import { loadNotes } from '../src/notes.js'
import { processCapture } from '../src/jobs/sweep.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const FOLLOW_UPS = {
  J2: '{"links":[]}',
  J3: '{"cards":[]}',
  J4: '{"cards":[]}',
  J6: '{"estimates":[]}',
}

async function captureWith(j1: string, name: string) {
  const paths = await initVault(await tmpVaultRoot(name), { git: false })
  await writeFile(join(paths.inbox, 'memo.md'), '다음 주 화요일 김부장 미팅')
  const report = await processCapture(paths, [new MockEngine({ J1: j1, ...FOLLOW_UPS })])
  expect(report.failed).toEqual([])
  const notes = await loadNotes(paths)
  expect(notes).toHaveLength(1)
  return notes[0]!
}

describe('J1 valid_until (deadline-aware freshness)', () => {
  it('date-only valid_until keeps the note fresh THROUGH the day, stale after', async () => {
    const note = await captureWith(
      '{"type":"event","decay":"ephemeral","body":"# 김부장 미팅","happened_at":"2026-07-14","valid_until":"2026-07-14"}',
      'vu-date',
    )
    expect(note.front.verified_until).toBe('2026-07-14T23:59:59')
    expect(freshnessOf(note, new Date('2026-07-14T12:00:00'))).not.toBe('stale')
    expect(freshnessOf(note, new Date('2026-07-15T09:00:00'))).toBe('stale')
  })

  it('a full timestamp passes through unchanged', async () => {
    const note = await captureWith(
      '{"type":"event","decay":"fast","body":"# 제출 마감","valid_until":"2026-07-20T14:00:00"}',
      'vu-time',
    )
    expect(note.front.verified_until).toBe('2026-07-20T14:00:00')
  })

  it('evergreen + valid_until downgrades decay so the date actually applies', async () => {
    const note = await captureWith(
      '{"type":"decision","decay":"evergreen","body":"# 계약 조건","valid_until":"2026-12-31"}',
      'vu-evergreen',
    )
    expect(note.front.decay).toBe('fast')
    expect(freshnessOf(note, new Date('2027-01-02T00:00:00'))).toBe('stale')
  })

  it('garbage valid_until is ignored — decay window applies as before', async () => {
    const note = await captureWith(
      '{"type":"note","decay":"slow","body":"# 메모","valid_until":"언젠가"}',
      'vu-garbage',
    )
    // default window: created + 180d, so verified_until is a real timestamp ≠ garbage
    expect(note.front.verified_until).toBeDefined()
    expect(Number.isNaN(Date.parse(note.front.verified_until!))).toBe(false)
  })
})
