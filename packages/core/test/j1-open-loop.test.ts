import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { isOpenLoop, loopUrgency } from '../src/loops.js'
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
  await writeFile(join(paths.inbox, 'memo.md'), '금요일까지 김부장에게 제안서 보내기')
  const report = await processCapture(paths, [new MockEngine({ J1: j1, ...FOLLOW_UPS })])
  expect(report.failed).toEqual([])
  const notes = await loadNotes(paths)
  expect(notes).toHaveLength(1)
  return notes[0]!
}

describe('J1 open_loop / due_at', () => {
  it('an intention with a stated deadline lands as a dated open loop', async () => {
    const note = await captureWith(
      '{"type":"note","decay":"fast","body":"# 제안서 보내기","open_loop":true,"due_at":"2026-07-31"}',
      'loop-dated',
    )
    expect(isOpenLoop(note)).toBe(true)
    expect(note.front.due_at).toBe('2026-07-31')
    // A date-only deadline stays "today" for the whole of that day.
    expect(loopUrgency(note, new Date('2026-07-31T23:00:00Z'))).toBe('today')
    expect(loopUrgency(note, new Date('2026-08-01T00:30:00Z'))).toBe('overdue')
  })

  it('an intention with no stated deadline is still a loop, just undated', async () => {
    const note = await captureWith('{"type":"note","decay":"slow","body":"# 이사 알아보기","open_loop":true}', 'loop-undated')
    expect(isOpenLoop(note)).toBe(true)
    expect(note.front.due_at).toBeUndefined()
    expect(loopUrgency(note, new Date('2026-07-31T00:00:00Z'))).toBe('no-deadline')
  })

  it('a plain fact is not a loop, and a due_at hung on one is dropped rather than written', async () => {
    const note = await captureWith(
      '{"type":"fact","decay":"evergreen","body":"# 서버 포트","due_at":"2026-07-31"}',
      'loop-absent',
    )
    expect(note.front.open_loop).toBeUndefined()
    expect(note.front.due_at).toBeUndefined()
    expect(isOpenLoop(note)).toBe(false)
  })

  it('a garbage due_at is dropped, so the note still parses on the next vault load', async () => {
    // createNote writes frontmatter as given — an unparseable date would only
    // explode later, taking the whole loadNotes pass down with it.
    const note = await captureWith(
      '{"type":"note","decay":"slow","body":"# 답장 보내기","open_loop":true,"due_at":"금요일쯤"}',
      'loop-garbage',
    )
    expect(isOpenLoop(note)).toBe(true)
    expect(note.front.due_at).toBeUndefined()
  })
})
