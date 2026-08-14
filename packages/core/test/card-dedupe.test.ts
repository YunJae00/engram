import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { approveCard, createCard, listCards, rejectCard } from '../src/cards.js'
import { buildJ1, buildJ3, buildJ4, buildJ5 } from '../src/jobs/librarian.js'
import { createNote, loadNotes, readNote, retireNote, writeNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-15T00:00:00Z')
const LATER = new Date('2026-07-15T01:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('card-dedupe'), { git: false })
})

describe('card issuance dedupe (one pending question per issue)', () => {
  it('same type + same target set with different wording returns the existing card', async () => {
    const first = await createCard(
      paths,
      { cardType: 'conflict', targets: ['n-a', 'n-b'], rationale: '규칙이 상충함', job: 'J3' },
      NOW,
    )
    const twin = await createCard(
      paths,
      { cardType: 'conflict', targets: ['n-b', 'n-a'], rationale: '다른 문장으로 같은 상충', job: 'J3' },
      LATER,
    )
    expect(twin.id).toBe(first.id)
    expect(await listCards(paths, 'proposed')).toHaveLength(1)
  })

  it('different card types about the same targets stay separate questions', async () => {
    await createCard(paths, { cardType: 'conflict', targets: ['n-a', 'n-b'], rationale: 'r' }, NOW)
    await createCard(paths, { cardType: 'merge', targets: ['n-a', 'n-b'], rationale: 'r', proposed: '# 병합' }, NOW)
    expect(await listCards(paths, 'proposed')).toHaveLength(2)
  })

  it('targetless new-note cards never dedupe against each other', async () => {
    await createCard(paths, { cardType: 'new-note', targets: [], rationale: 'r', proposed: '# 첫 캡처' }, NOW)
    await createCard(paths, { cardType: 'new-note', targets: [], rationale: 'r', proposed: '# 둘째 캡처' }, NOW)
    expect(await listCards(paths, 'proposed')).toHaveLength(2)
  })
})

describe('approval dismisses overlapping pending cards', () => {
  it('resolving one card retires the siblings whose shared target it consumed', async () => {
    const old = await createNote(paths, { body: '# rate limit\n\n분당 60.' }, NOW)
    const fresh = await createNote(paths, { body: '# rate limit 상향\n\n분당 600.' }, NOW)
    const other = await createNote(paths, { body: '# 무관한 노트' }, NOW)
    const conflict = await createCard(
      paths,
      { cardType: 'conflict', targets: [old.front.id, fresh.front.id], rationale: '수치 상충' },
      NOW,
    )
    const stale = await createCard(
      paths,
      { cardType: 'stale', targets: [old.front.id], rationale: '기한 경과', proposed: '재검증' },
      NOW,
    )
    const unrelated = await createCard(
      paths,
      { cardType: 'stale', targets: [other.front.id], rationale: '기한 경과', proposed: '재검증' },
      NOW,
    )
    await approveCard(paths, conflict.id, { choice: 'B' }, LATER)
    const remaining = await listCards(paths, 'proposed')
    expect(remaining.map((c) => c.id)).toEqual([unrelated.id])
    expect((await listCards(paths)).find((c) => c.id === stale.id)?.status).toBe('dismissed')
  })

  it('a sibling whose shared target the answer only re-stamped stays proposed', async () => {
    const old = await createNote(paths, { body: '# 이사 준비\n\n진행 중인 항목이 남아 있음.' }, NOW)
    const fresh = await createNote(paths, { body: '# 이사 준비 완료\n\n전 항목 완료함.' }, NOW)
    const supersede = await createCard(
      paths,
      {
        cardType: 'supersede',
        targets: [old.front.id],
        rationale: '구노트는 진행 중, 신노트는 전 항목 완료 → 구 상태는 더 이상 참이 아님',
        proposed: '# 이사 준비 완료\n\n전 항목 완료함.',
        job: 'J4',
      },
      NOW,
    )
    const conflict = await createCard(
      paths,
      { cardType: 'conflict', targets: [old.front.id, fresh.front.id], rationale: '진행 중 vs 완료' },
      NOW,
    )

    await approveCard(paths, conflict.id, { choice: 'both' }, LATER)
    expect((await listCards(paths, 'proposed')).map((c) => c.id)).toEqual([supersede.id])

    // …and the surviving question still resolves into a real supersede chain.
    await approveCard(paths, supersede.id, {}, new Date(LATER.getTime() + 60_000))
    expect((await readNote(paths, old.front.id)).front.status).toBe('superseded')
    expect((await readNote(paths, fresh.front.id)).front.supersedes).toContain(old.front.id)
  })

  it('a sibling judged against a body the user has since rewritten is dismissed', async () => {
    const shared = await createNote(paths, { body: '# 요금제\n\n프로 요금제는 월 5만원임.' }, NOW)
    const other = await createNote(paths, { body: '# 요금제 문의\n\n가격 문의가 들어옴.' }, NOW)
    const pending = await createCard(
      paths,
      { cardType: 'supersede', targets: [shared.front.id], rationale: 'r', proposed: '# 요금제\n\n프로 요금제는 월 7만원임.' },
      NOW,
    )
    // The human rewrites the note itself — the pending proposal now argues
    // about content that is gone.
    const edited = await readNote(paths, shared.front.id)
    edited.body = '# 요금제\n\n요금제를 전면 개편해 티어를 셋으로 나눔.'
    edited.front.updated = LATER.toISOString()
    await writeNote(paths, edited)

    const sibling = await createCard(
      paths,
      { cardType: 'conflict', targets: [shared.front.id, other.front.id], rationale: '개편안 상충' },
      LATER,
    )
    await approveCard(paths, sibling.id, { choice: 'both' }, new Date(LATER.getTime() + 60_000))
    expect((await listCards(paths)).find((c) => c.id === pending.id)?.status).toBe('dismissed')
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
  })
})

describe('supersede approval reuses an existing identical note', () => {
  it('points supersedes at the existing note instead of creating a copy', async () => {
    const old = await createNote(paths, { body: '# rate limit\n\n분당 60 요청.' }, NOW)
    const fresh = await createNote(paths, { body: '# rate limit 상향\n\n분당 600으로 상향됨.' }, NOW)
    const card = await createCard(
      paths,
      {
        cardType: 'supersede',
        targets: [old.front.id],
        rationale: '더 이상 참이 아님',
        // the engine copied the newer note's body, with different wrapping
        proposed: '# rate limit 상향\n\n분당 600으로   상향됨.\n',
        job: 'J4',
      },
      NOW,
    )
    const notesBefore = (await loadNotes(paths)).length
    await approveCard(paths, card.id, {}, LATER)
    expect((await loadNotes(paths)).length).toBe(notesBefore) // no duplicate note
    expect((await readNote(paths, old.front.id)).front.status).toBe('superseded')
    expect((await readNote(paths, fresh.front.id)).front.supersedes).toContain(old.front.id)
  })

  it('still creates the replacement when no identical note exists', async () => {
    const old = await createNote(paths, { body: '# 옛 사실' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'supersede', targets: [old.front.id], rationale: 'r', proposed: '# 새 사실\n\n갱신된 내용.' },
      NOW,
    )
    const notesBefore = (await loadNotes(paths)).length
    await approveCard(paths, card.id, {}, LATER)
    expect((await loadNotes(paths)).length).toBe(notesBefore + 1)
  })
})

describe('issuance guards (no re-asking answered questions)', () => {
  const cardsJson = (cards: unknown[]) => JSON.stringify({ cards })

  it('drops judgment cards whose target was already superseded', async () => {
    const old = await createNote(paths, { body: '# rate limit\n\n분당 60 요청 제한.' }, NOW)
    await retireNote(paths, old.front.id, NOW)
    const corpus = await loadNotes(paths)
    const job = buildJ4(paths, 'AGENTS', corpus, corpus, LATER)
    const effects = await job.apply!(
      cardsJson([{ cardType: 'supersede', targets: [old.front.id], rationale: 'r', proposed: '# rate limit\n\n분당 600으로 상향된 새 본문임.' }]),
    )
    expect(effects.join()).toMatch(/targets already superseded/)
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
  })

  it('skips a re-finding on unchanged notes after the user already answered it', async () => {
    const a = await createNote(paths, { body: '# 배포 정책\n\n금요일 배포 금지 원칙임.' }, NOW)
    const b = await createNote(paths, { body: '# 배포 정책 갱신\n\n금요일 오전 배포 허용함.' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '상충' },
      NOW,
    )
    await approveCard(paths, card.id, { choice: 'both' }, LATER)
    const corpus = await loadNotes(paths)
    const job = buildJ3(paths, 'AGENTS', corpus, corpus, new Date(LATER.getTime() + 60_000))
    const effects = await job.apply!(
      cardsJson([{ cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '같은 상충 재발견' }]),
    )
    expect(effects.join()).toMatch(/already answered/)
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
    // and the notes were NOT re-disputed
    expect((await readNote(paths, a.front.id)).front.status).toBe('current')
  })

  it('a pair that already has an open card does not also collect a conflict', async () => {
    const old = await createNote(paths, { body: '# 마이그레이션\n\n자동화 없음. 수동 실행이 유일한 경로임.' }, NOW)
    const fresh = await createNote(paths, { body: '# 마이그레이션 자동화\n\nmigrate.py 도입으로 자동 반영됨.' }, NOW)
    await createCard(
      paths,
      {
        cardType: 'supersede',
        targets: [old.front.id, fresh.front.id],
        rationale: '구 정보가 더 이상 참이 아님',
        proposed: '# 마이그레이션 자동화\n\nmigrate.py의 run_migrations()로 자동 반영됨.',
        job: 'J4',
      },
      NOW,
    )
    const corpus = await loadNotes(paths)
    const job = buildJ3(paths, 'AGENTS', corpus, corpus, LATER)
    const effects = await job.apply!(
      // Target order reversed on purpose: it is the same pair either way.
      cardsJson([{ cardType: 'conflict', targets: [fresh.front.id, old.front.id], rationale: '자동화 유무가 상충함' }]),
    )
    expect(effects.join()).toMatch(/an open card already covers/)
    expect(await listCards(paths, 'proposed')).toHaveLength(1)
    // …and the notes were not dragged into `disputed` over a question that is
    // already being asked in a more useful form.
    expect((await readNote(paths, old.front.id)).front.status).toBe('current')
  })

  it('answering a NEIGHBOUR card does not resurrect a settled question (librarian frontmatter edits are invisible)', async () => {
    const a = await createNote(paths, { body: '# 세션 만료\n\n세션은 24시간 유지함.' }, NOW)
    const b = await createNote(paths, { body: '# 세션 단축\n\n보안 감사로 8시간 단축함.' }, NOW)
    const c = await createNote(paths, { body: '# 세션 재조정\n\n제품 요구로 12시간 재조정함.' }, NOW)
    const settled = await createCard(
      paths,
      { cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '24h vs 8h' },
      NOW,
    )
    await approveCard(paths, settled.id, { choice: 'both' }, LATER)
    // a neighbour answer now touches note b again (frontmatter only)
    const neighbour = await createCard(
      paths,
      { cardType: 'conflict', targets: [b.front.id, c.front.id], rationale: '8h vs 12h' },
      new Date(LATER.getTime() + 30_000),
    )
    await approveCard(paths, neighbour.id, { choice: 'both' }, new Date(LATER.getTime() + 60_000))
    // re-deriving the FIRST finding must still be recognized as answered
    const corpus = await loadNotes(paths)
    const job = buildJ3(paths, 'AGENTS', corpus, corpus, new Date(LATER.getTime() + 120_000))
    const effects = await job.apply!(
      cardsJson([{ cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '같은 상충 재발견' }]),
    )
    expect(effects.join()).toMatch(/already answered/)
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
  })

  it('a real edit after the answer re-opens the question', async () => {
    const a = await createNote(paths, { body: '# 정책 A\n\n원칙 첫 버전임.' }, NOW)
    const b = await createNote(paths, { body: '# 정책 B\n\n다른 원칙임.' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '상충' },
      NOW,
    )
    await approveCard(paths, card.id, { choice: 'both' }, LATER)
    const edited = await readNote(paths, b.front.id)
    edited.body = '# 정책 B\n\n전면 개정된 새 원칙임.'
    edited.front.updated = new Date(LATER.getTime() + 60_000).toISOString()
    await writeNote(paths, edited)
    const corpus = await loadNotes(paths)
    const job = buildJ3(paths, 'AGENTS', corpus, corpus, new Date(LATER.getTime() + 120_000))
    const effects = await job.apply!(
      cardsJson([{ cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '개정 후 새 상충' }]),
    )
    expect(effects.join()).toMatch(/card raised/)
    expect(await listCards(paths, 'proposed')).toHaveLength(1)
  })

  it('stale re-expiry is never suppressed by an earlier stale answer', async () => {
    const note = await createNote(paths, { body: '# 만료 노트\n\n기한이 있는 사실임.', decay: 'fast' }, NOW)
    const first = await createCard(
      paths,
      { cardType: 'stale', targets: [note.front.id], rationale: '만료', proposed: '재확인' },
      NOW,
    )
    await approveCard(paths, first.id, { action: 'keep' }, LATER)
    const job = buildJ5(paths, 'AGENTS', [await readNote(paths, note.front.id)], new Date(LATER.getTime() + 60_000))
    const effects = await job.apply!(
      cardsJson([{ cardType: 'stale', targets: [note.front.id], rationale: '다시 만료', proposed: '재확인' }]),
    )
    expect(effects.join()).toMatch(/card raised/)
  })
})

describe('dead conflict cards release their disputed pin', () => {
  it('sibling dismissal restores the surviving disputed note to current', async () => {
    const old = await createNote(paths, { body: '# rate limit\n\n분당 60 요청 제한임.' }, NOW)
    const fresh = await createNote(paths, { body: '# rate limit 상향\n\n분당 600으로 상향됨.' }, NOW)
    const corpus = await loadNotes(paths)
    // J3 finds the conflict → both notes disputed, conflict card pending
    await buildJ3(paths, 'AGENTS', corpus, corpus, NOW).apply!(
      JSON.stringify({ cards: [{ cardType: 'conflict', targets: [old.front.id, fresh.front.id], rationale: '수치 상충' }] }),
    )
    expect((await readNote(paths, fresh.front.id)).front.status).toBe('disputed')
    // the user answers the SIBLING supersede card instead
    const supersede = await createCard(
      paths,
      { cardType: 'supersede', targets: [old.front.id], rationale: 'r', proposed: '# 완전히 새로운 본문\n\n다른 내용임.' },
      NOW,
    )
    await approveCard(paths, supersede.id, {}, LATER)
    expect((await readNote(paths, old.front.id)).front.status).toBe('superseded')
    expect((await readNote(paths, fresh.front.id)).front.status).toBe('current') // released
    const conflict = (await listCards(paths)).find((c) => c.cardType === 'conflict')
    expect(conflict?.status).toBe('dismissed')
    expect(conflict?.resolved).toBeTruthy()
  })

  it('rejecting a conflict card lifts disputed from both targets', async () => {
    const a = await createNote(paths, { body: '# A\n\n내용 A임.' }, NOW)
    const b = await createNote(paths, { body: '# B\n\n내용 B임.' }, NOW)
    const corpus = await loadNotes(paths)
    await buildJ3(paths, 'AGENTS', corpus, corpus, NOW).apply!(
      JSON.stringify({ cards: [{ cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '오탐' }] }),
    )
    const card = (await listCards(paths, 'proposed'))[0]!
    await rejectCard(paths, card.id, '실제 상충 아님', LATER)
    expect((await readNote(paths, a.front.id)).front.status).toBe('current')
    expect((await readNote(paths, b.front.id)).front.status).toBe('current')
  })
})

describe('supersede approval reuses a REPHRASED twin (house style rewrite)', () => {
  it('same title + high bigram overlap matches despite particle changes', async () => {
    const old = await createNote(paths, { body: '# 외부 API rate limit\n\n파트너 API rate limit은 분당 60 요청.' }, NOW)
    const fresh = await createNote(
      paths,
      { body: '# 파트너 API rate limit 상향\n\n파트너사가 우리 플랜의 rate limit을 분당 600으로 상향해줬다 (7월 계약 갱신). 배치 스로틀 상수 업데이트 필요. 429 백오프 로직은 그대로 두는 게 안전.' },
      NOW,
    )
    const card = await createCard(
      paths,
      {
        cardType: 'supersede',
        targets: [old.front.id],
        rationale: '더 이상 참이 아님',
        proposed: '# 파트너 API rate limit 상향\n\n파트너사가 플랜 rate limit을 분당 600으로 상향함 (7월 계약 갱신). 배치 스로틀 상수 업데이트 필요함. 429 백오프 로직은 그대로 유지하는 것이 안전함.',
        job: 'J4',
      },
      NOW,
    )
    const notesBefore = (await loadNotes(paths)).length
    await approveCard(paths, card.id, {}, LATER)
    expect((await loadNotes(paths)).length).toBe(notesBefore) // no duplicate
    expect((await readNote(paths, fresh.front.id)).front.supersedes).toContain(old.front.id)
    expect((await readNote(paths, old.front.id)).front.status).toBe('superseded')
  })

  it('reuses the twin even while a sibling conflict card still holds it disputed', async () => {
    const old = await createNote(paths, { body: '# 배포 정책: 금요일 배포 금지\n\n금요일에는 프로덕션 배포를 하지 않는다.' }, NOW)
    const fresh = await createNote(
      paths,
      { body: '# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리 배포 + 자동 롤백이 도입돼서 금요일 오전(11시 이전) 배포는 허용하기로 했다. 금요일 오후는 여전히 금지.' },
      NOW,
    )
    const corpus = await loadNotes(paths)
    await buildJ3(paths, 'AGENTS', corpus, corpus, NOW).apply!(
      JSON.stringify({ cards: [{ cardType: 'conflict', targets: [old.front.id, fresh.front.id], rationale: '상충' }] }),
    )
    expect((await readNote(paths, fresh.front.id)).front.status).toBe('disputed')
    const supersede = await createCard(
      paths,
      {
        cardType: 'supersede',
        targets: [old.front.id],
        rationale: '구 정책은 더 이상 참이 아님',
        proposed: '# 배포 정책 갱신: 금요일 오전 배포 허용\n\n카나리 배포 + 자동 롤백 도입으로 금요일 오전(11시 이전) 배포를 허용함. 금요일 오후는 여전히 금지임.',
        job: 'J4',
      },
      NOW,
    )
    const notesBefore = (await loadNotes(paths)).length
    await approveCard(paths, supersede.id, {}, LATER)
    expect((await loadNotes(paths)).length).toBe(notesBefore) // no duplicate
    const kept = await readNote(paths, fresh.front.id)
    expect(kept.front.supersedes).toContain(old.front.id)
    expect(kept.front.status).toBe('current') // dispute released with the dead conflict card
    expect((await readNote(paths, old.front.id)).front.status).toBe('superseded')
  })

  it('same title but genuinely different content still creates a new note', async () => {
    const old = await createNote(paths, { body: '# 회의 메모\n\n지난 분기 예산 회의 내용임.' }, NOW)
    await createNote(paths, { body: '# 회의 메모\n\n신규 채용 면접 일정과 평가 기준 논의함.' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'supersede', targets: [old.front.id], rationale: 'r', proposed: '# 회의 메모\n\n올해 예산 확정치와 집행 계획 정리함.' },
      NOW,
    )
    const notesBefore = (await loadNotes(paths)).length
    await approveCard(paths, card.id, {}, LATER)
    expect((await loadNotes(paths)).length).toBe(notesBefore + 1)
  })
})

describe('J1 absorb claims the scrap first (idempotent per source)', () => {
  const RESULT = JSON.stringify({ type: 'note', decay: 'slow', body: '# 캡처 노트\n\n본문.' })

  it('a twin J1 for the same inbox file skips instead of absorbing twice', async () => {
    await writeFile(join(paths.inbox, 'cap.md'), '캡처 원문')
    const job1 = buildJ1(paths, 'AGENTS', 'cap.md', '캡처 원문', NOW)
    const job2 = buildJ1(paths, 'AGENTS', 'cap.md', '캡처 원문', NOW)
    const out1 = await job1.apply!(RESULT)
    const out2 = await job2.apply!(RESULT)
    expect(out1[0]).toMatch(/note created/)
    expect(out2[0]).toMatch(/skipped/)
    expect((await loadNotes(paths)).length).toBe(1)
    expect(await readdir(paths.sources)).toEqual(['cap.md'])
    expect(await readFile(join(paths.sources, 'cap.md'), 'utf8')).toBe('캡처 원문')
  })

  it('a failing absorb returns the scrap to inbox for retry', async () => {
    await writeFile(join(paths.inbox, 'bad.md'), '캡처 원문')
    const job = buildJ1(paths, 'AGENTS', 'bad.md', '캡처 원문', NOW)
    await expect(job.apply!('not json at all')).rejects.toThrow()
    expect(await readdir(paths.inbox)).toContain('bad.md')
  })
})
