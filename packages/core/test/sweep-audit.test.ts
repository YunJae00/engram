import { describe, expect, it } from 'vitest'
import { listCards } from '../src/cards.js'
import { MockEngine } from '../src/engine/mock.js'
import { auditSlice, loadState, sweep } from '../src/jobs/sweep.js'
import { createNote, loadNotes } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const DAY_ONE = new Date('2026-07-12T00:00:00Z')
const DAY_TWO = new Date('2026-07-13T00:00:00Z')
const DAY_THREE = new Date('2026-07-14T00:00:00Z')

// The stale fact sorts inside the first slice; its replacement sorts far past
// it, so the audit must retrieve it as a CANDIDATE — the pre-existing
// contradiction shape, with neither note in any delta.
const OLD_ID = 'n-a12-old'
const NEW_ID = 'n-z99-new'
const REPLACEMENT = '# 배포 요일\n\n배포는 금요일임 (7월 정책 변경).'

async function seedStandingCorpus(paths: VaultPaths): Promise<void> {
  for (let i = 1; i <= 11; i++) {
    await createNote(paths, { id: `n-a${String(i).padStart(2, '0')}`, body: `# 메모 ${i}\n\n관련 없는 본문임.` }, DAY_ONE)
  }
  await createNote(paths, { id: OLD_ID, body: '# 배포 요일\n\n배포는 화요일임.' }, DAY_ONE)
  for (let i = 1; i <= 7; i++) {
    await createNote(paths, { id: `n-b${String(i).padStart(2, '0')}`, body: `# 잡담 ${i}\n\n관련 없는 본문임.` }, DAY_ONE)
  }
  await createNote(paths, { id: NEW_ID, body: REPLACEMENT }, DAY_ONE)
}

// Records every J4 payload so a test can see exactly which notes were judged
// against which corpus. The payload is the LAST json fence of the prompt.
function j4Recorder(cards: string) {
  const payloads: { changed: string[]; corpus: string[] }[] = []
  const respond = (prompt: string) => {
    const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
    const last = blocks[blocks.length - 1]
    if (!last) throw new Error('no json payload in the J4 prompt')
    const parsed = JSON.parse(last[1]!) as { changed?: { id: string }[]; corpus?: { id: string }[] }
    payloads.push({
      changed: (parsed.changed ?? []).map((n) => n.id),
      corpus: (parsed.corpus ?? []).map((n) => n.id),
    })
    return cards
  }
  return { payloads, respond }
}

function engineWith(j4: (prompt: string) => string): MockEngine {
  return new MockEngine({
    J1: '{"type":"note","decay":"slow","body":"# 메모\\n\\n본문."}',
    J2: '{"links":[]}',
    J3: '{"cards":[]}',
    J4: j4,
    J5: '{"cards":[]}',
    J6: '{"estimates":[]}',
    J7: '{"cards":[]}',
    J8: '# 브리핑\n\n요약.',
    J9: '{"body":"# 허브\\n\\n종합."}',
    J10: '# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- 정리함.',
  })
}

const SUPERSEDE_CARD = JSON.stringify({
  cards: [
    {
      cardType: 'supersede',
      targets: [OLD_ID],
      rationale: '배포 요일이 화요일에서 금요일로 바뀜 — 구노트는 더 이상 참이 아님',
      proposed: REPLACEMENT,
    },
  ],
})

describe('auditSlice (rotating window over the standing corpus)', () => {
  const notes = async (paths: VaultPaths) => loadNotes(paths)

  it('walks the corpus a slice at a time and wraps at the end', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-slice'), { git: false })
    for (const id of ['n-1', 'n-2', 'n-3', 'n-4', 'n-5']) {
      await createNote(paths, { id, body: `# ${id}\n\n본문임.` }, DAY_ONE)
    }
    const all = await notes(paths)
    expect(auditSlice(all, new Set(), undefined, 2).map((n) => n.front.id)).toEqual(['n-1', 'n-2'])
    expect(auditSlice(all, new Set(), 'n-2', 2).map((n) => n.front.id)).toEqual(['n-3', 'n-4'])
    // past the end → the window wraps rather than stalling on the tail
    expect(auditSlice(all, new Set(), 'n-4', 2).map((n) => n.front.id)).toEqual(['n-5', 'n-1'])
    expect(auditSlice(all, new Set(), 'n-5', 2).map((n) => n.front.id)).toEqual(['n-1', 'n-2'])
  })

  it('never re-opens resolved questions: superseded notes, hubs and the delta stay out', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-exclude'), { git: false })
    await createNote(paths, { id: 'n-1', body: '# 살아있음\n\n본문임.' }, DAY_ONE)
    await createNote(paths, { id: 'n-2', body: '# 대체됨\n\n본문임.', status: 'superseded' }, DAY_ONE)
    await createNote(paths, { id: 'n-3', body: '# 허브\n\n종합.', type: 'hub' }, DAY_ONE)
    await createNote(paths, { id: 'n-4', body: '# 이번 델타\n\n본문임.' }, DAY_ONE)
    const slice = auditSlice(await notes(paths), new Set(['n-4']), undefined, 10)
    expect(slice.map((n) => n.front.id)).toEqual(['n-1'])
  })
})

describe('sweep audits the standing corpus', () => {
  it('re-judges untouched notes a capped slice at a time and raises the supersede card', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-sweep'), { git: false })
    await seedStandingCorpus(paths)

    // Sweep 1: nothing has been swept yet, so the delta IS the whole vault —
    // the audit has nothing left to add and only arms its cadence.
    const first = j4Recorder('{"cards":[]}')
    await sweep(paths, [engineWith(first.respond)], { now: () => DAY_ONE })
    expect(first.payloads).toHaveLength(1)
    expect(first.payloads[0]!.changed).toHaveLength(20)
    expect(typeof (await loadState(paths)).last_audit).toBe('string')

    // Sweep 2 a day later: nothing changed, so the delta is empty and the old
    // pass would have queued no J4 at all. The audit picks the first slice.
    const second = j4Recorder(SUPERSEDE_CARD)
    await sweep(paths, [engineWith(second.respond)], { now: () => DAY_TWO })
    expect(second.payloads).toHaveLength(1)
    const audited = second.payloads[0]!
    expect(audited.changed).toHaveLength(12) // AUDIT_CAP — never the whole vault
    expect(audited.changed).toContain(OLD_ID)
    expect(audited.corpus).toContain(NEW_ID) // the contradiction is in the prompt
    expect(audited.corpus).not.toContain(OLD_ID)

    const card = (await listCards(paths, 'proposed')).find((c) => c.cardType === 'supersede')
    expect(card?.targets).toEqual([OLD_ID])
    expect(card?.job).toBe('J4')
  }, 60_000)

  it('advances the cursor so the next pass examines the notes the last one missed', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-cursor'), { git: false })
    await seedStandingCorpus(paths)

    await sweep(paths, [engineWith(j4Recorder('{"cards":[]}').respond)], { now: () => DAY_ONE })
    const second = j4Recorder('{"cards":[]}')
    await sweep(paths, [engineWith(second.respond)], { now: () => DAY_TWO })
    expect((await loadState(paths)).audit_cursor).toBe(OLD_ID)

    const third = j4Recorder('{"cards":[]}')
    await sweep(paths, [engineWith(third.respond)], { now: () => DAY_THREE })
    const audited = third.payloads[0]!
    expect(audited.changed).toHaveLength(12)
    // The tail the first slice never reached — including the newer note.
    expect(audited.changed).toContain(NEW_ID)
    expect(audited.changed).not.toContain(OLD_ID)
  }, 60_000)

  it('holds the daily cadence: a second sweep the same day queues no audit', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-cadence'), { git: false })
    await seedStandingCorpus(paths)

    await sweep(paths, [engineWith(j4Recorder('{"cards":[]}').respond)], { now: () => DAY_ONE })
    const again = j4Recorder('{"cards":[]}')
    await sweep(paths, [engineWith(again.respond)], { now: () => new Date('2026-07-12T06:00:00Z') })
    expect(again.payloads).toEqual([])
  }, 60_000)
})
