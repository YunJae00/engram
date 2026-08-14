import { beforeEach, describe, expect, it } from 'vitest'
import { markContext, markOrigin, readContext, readOrigin, sanitizeContext, stripProvenanceMarkers, writeCapture } from '../src/capture.js'
import { createCard, listCards } from '../src/cards.js'
import { buildJ12, resolvableCards } from '../src/jobs/resolve.js'
import { createNote, readNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-30T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('machine-written'), { git: false })
})

describe('capture provenance', () => {
  it('a plain capture is the user’s', () => {
    expect(readOrigin('# 회의 결론\n\n금요일 배포 금지.')).toBe('user')
  })

  it('a harvested capture says so, and survives a round trip', async () => {
    const marked = markOrigin('# 세션 결론\n\n타임아웃을 미설치로 읽지 말 것.', 'session')
    expect(readOrigin(marked)).toBe('session')
    const { file } = await writeCapture(paths.inbox, '# 세션 결론\n\n본문.', 'session')
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    expect(readOrigin(await readFile(join(paths.inbox, file), 'utf8'))).toBe('session')
  })

  it('AN UNMARKED NOTE IS THE USER’S — the default must never be the risky one', () => {
    // Every note written before this field existed was a deliberate capture.
    // If absent ever read as 'session', one release would start silently
    // rewriting years of someone's own memories.
    expect(readOrigin('')).toBe('user')
    expect(readOrigin('<!-- something else -->\n# 노트')).toBe('user')
    expect(readOrigin('# 노트\n\n<!-- engram:origin=session -->')).toBe('user')
  })
})

describe('capture context — where a memory came from', () => {
  it('the folder label survives the trip into the capture file, next to origin', async () => {
    const { file } = await writeCapture(paths.inbox, '# team 구조\n\nowner는 회사당 1명.', 'session', 'chatx')
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const content = await readFile(join(paths.inbox, file), 'utf8')
    expect(readOrigin(content)).toBe('session')
    expect(readContext(content)).toBe('chatx')
    // The engine-facing text carries neither marker — provenance is
    // bookkeeping, not something to be copied into a memory's body.
    const stripped = stripProvenanceMarkers(content)
    expect(stripped).not.toContain('engram:')
    expect(stripped).toContain('# team 구조')
  })

  it('a label cannot break out of its comment or stretch into a paragraph', () => {
    expect(sanitizeContext('a --> b\nc')).toBe('a  b c')
    expect(sanitizeContext('x'.repeat(200))).toHaveLength(60)
    expect(readContext(markContext('# 본문', '  '))).toBeUndefined()
  })

  it('the filed note keeps the label through frontmatter serialization', async () => {
    const note = await createNote(paths, { id: 'n-ctx', body: '# Team\n\n본문.', origin: 'session', context: 'chatx' }, NOW)
    expect(note.front.context).toBe('chatx')
    const { readNote } = await import('../src/notes.js')
    expect((await readNote(paths, 'n-ctx')).front.context).toBe('chatx')
  })
})

describe('the autonomic librarian and the provenance line', () => {
  const machine = (id: string, body: string) =>
    createNote(paths, { id, body, origin: 'session' }, NOW)
  const mine = (id: string, body: string) => createNote(paths, { id, body }, NOW)

  const conflictCard = async (a: string, b: string) =>
    createCard(paths, { cardType: 'conflict', targets: [a, b], rationale: '서술이 어긋남', job: 'J3' }, NOW)

  const applyVerdict = async (verdict: object) => {
    const [entry] = await resolvableCards(paths)
    expect(entry).toBeDefined()
    return buildJ12(paths, 'agents', entry!, NOW).apply!(JSON.stringify(verdict))
  }

  it('EVERY pair is its to attempt now — user notes included', async () => {
    const a = await machine('n-sess-a', '# 배포\n\n금요일 배포 가능.')
    const b = await mine('n-mine-a', '# 배포 원칙\n\n금요일 배포 금지.')
    await conflictCard(a.front.id, b.front.id)
    expect(await resolvableCards(paths)).toHaveLength(1)
  })

  it('a machine-written loser retires as judged', async () => {
    const a = await machine('n-sess-b', '# 옛 요약\n\n타임아웃 30초.')
    const b = await machine('n-sess-c', '# 새 요약\n\n타임아웃 60초로 상향.')
    await conflictCard(a.front.id, b.front.id)
    await applyVerdict({ verdict: 'resolve', winner: b.front.id, reason: '나중 것이 이김' })
    expect((await readNote(paths, a.front.id)).front.status).toBe('superseded')
    expect((await readNote(paths, b.front.id)).front.status).toBe('current')
  })

  it('a resolve that would retire a USER note lands as keep-both — the memory stays', async () => {
    const a = await machine('n-sess-d', '# 기계 결론\n\n금요일 배포 가능.')
    const b = await mine('n-mine-b', '# 내 원칙\n\n금요일 배포 금지.')
    await conflictCard(a.front.id, b.front.id)
    const effects = await applyVerdict({ verdict: 'resolve', winner: a.front.id, reason: '기계가 이겼다고 봄' })
    expect(effects.join(' ')).toContain('user note protected')
    expect((await readNote(paths, a.front.id)).front.status).toBe('current')
    expect((await readNote(paths, b.front.id)).front.status).toBe('current')
    expect((await listCards(paths, 'proposed'))).toHaveLength(0) // the question is gone
  })

  it('a merge that would swallow a USER note is refused, both notes untouched', async () => {
    const a = await machine('n-sess-e', '# 기계 메모\n\n본문 A.')
    const b = await mine('n-mine-c', '# 내 메모\n\n본문 B.')
    await createCard(
      paths,
      { cardType: 'merge', targets: [a.front.id, b.front.id], rationale: '중복', proposed: '# 합친 본문\n\n둘을 합침.', job: 'J7' },
      NOW,
    )
    await applyVerdict({ verdict: 'resolve', winner: a.front.id, reason: '중복이라 봄' })
    expect((await readNote(paths, a.front.id)).front.status).toBe('current')
    expect((await readNote(paths, b.front.id)).front.status).toBe('current')
    expect((await listCards(paths, 'rejected')).map((c) => c.cardType)).toEqual(['merge'])
  })

  it('escalate lands silently and is attempted exactly once', async () => {
    const a = await machine('n-sess-f', '# 측정 A\n\n분당 60.')
    const b = await machine('n-sess-g', '# 측정 B\n\n분당 600.')
    await conflictCard(a.front.id, b.front.id)
    const effects = await applyVerdict({ verdict: 'escalate', reason: '어느 측정이 맞는지 본문에 없음' })
    expect(effects.join(' ')).toContain('held quietly')
    // Still in the archive for a human — but off the resolver's desk, so the
    // next sweep does not re-judge it (the idempotency gate caught this).
    expect(await listCards(paths, 'proposed')).toHaveLength(1)
    expect(await resolvableCards(paths)).toHaveLength(0)
  })

  it('stale is never auto-resolved — no amount of reading answers "is this still true?"', async () => {
    const a = await machine('n-sess-h', '# 오래된 사실\n\n본문.')
    await createCard(paths, { cardType: 'stale', targets: [a.front.id], rationale: '신선도 확인 필요', job: 'J5' }, NOW)
    expect(await resolvableCards(paths)).toHaveLength(0)
  })

  it('a card naming a note that no longer exists is left alone', async () => {
    const a = await machine('n-sess-i', '# 남은 노트\n\n본문.')
    await createCard(
      paths,
      { cardType: 'merge', targets: [a.front.id, 'n-gone'], rationale: '중복', proposed: '# 합침', job: 'J7' },
      NOW,
    )
    expect(await resolvableCards(paths)).toHaveLength(0)
  })
})
