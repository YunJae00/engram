import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { appendCounterexample, approveCard, listCards, rejectCard } from '../src/cards.js'
import { MockEngine } from '../src/engine/mock.js'
import { createNote, loadNotes, readNote } from '../src/notes.js'
import { processCapture, sweep } from '../src/jobs/sweep.js'
import { generateSampleVault } from '../src/sample-vault.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

describe('MockEngine golden scenarios (M2 acceptance)', () => {
  let engine: MockEngine

  beforeAll(async () => {
    engine = await MockEngine.fromDir(MOCK_DIR)
  })

  it('캡처 → J1 노트화: inbox item becomes a schema-valid note, source archived', async () => {
    const paths = await initVault(await tmpVaultRoot('golden-j1'), { git: false })
    await writeFile(join(paths.inbox, 'memo.md'), '주간 회의: 로그인 개편 금요일 배포, 담당 지민')
    const report = await processCapture(paths, [engine])
    expect(report.failed).toEqual([])
    const notes = await loadNotes(paths)
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(note.front.type).toBe('meeting')
    expect(note.front.decay).toBe('fast')
    expect(note.front.source).toContain('memo.md')
    expect(await readdir(paths.inbox)).toEqual([])
    expect(await readFile(join(paths.sources, 'memo.md'), 'utf8')).toContain('주간 회의')
  })

  it('모순 쌍 → 충돌 카드 + disputed 전환', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('golden-j3'))
    await sweep(paths, [engine])
    const cards = await listCards(paths, 'proposed')
    const conflict = cards.find((c) => c.cardType === 'conflict')
    expect(conflict?.targets).toEqual(['n-price-0001', 'n-price-0002'])
    expect((await readNote(paths, 'n-price-0001')).front.status).toBe('disputed')
  })

  it('만료 → stale 카드', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('golden-j5'))
    await sweep(paths, [engine])
    const cards = await listCards(paths, 'proposed')
    const stale = cards.filter((c) => c.cardType === 'stale')
    expect(stale.flatMap((c) => c.targets)).toContain('n-sprint-0001')
  })

  it('갱신 정보 → supersede 카드 → 승인 시 체인 반영', async () => {
    const paths = await initVault(await tmpVaultRoot('golden-j4'), { git: false })
    await createNote(paths, { id: 'n-old-0001', body: '# 배포 요일\n\n배포는 화요일이다.' })
    const scripted = new MockEngine({
      J2: '{"links":[]}',
      J3: '{"cards":[]}',
      J4: '{"cards":[{"cardType":"supersede","targets":["n-old-0001"],"rationale":"배포 요일이 금요일로 변경됨","proposed":"# 배포 요일\\n\\n배포는 금요일이다."}]}',
      J5: '{"cards":[]}',
      J6: '{"estimates":[]}',
      J7: '{"cards":[]}',
      J8: '# 브리핑\n\nsupersede 1건 제안.',
      J10: '# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- 배포 요일 갱신.',
    })
    await sweep(paths, [scripted])
    const card = (await listCards(paths, 'proposed')).find((c) => c.cardType === 'supersede')
    expect(card).toBeDefined()
    await approveCard(paths, card!.id)
    const old = await readNote(paths, 'n-old-0001')
    expect(old.front.status).toBe('superseded')
    const current = (await loadNotes(paths)).find((n) => n.front.supersedes.includes('n-old-0001'))
    expect(current?.front.status).toBe('current')
    expect(current?.body).toContain('금요일')
  })

  it('거절 → AGENTS.md 반례 추가 (교정 루프)', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('golden-reject'))
    await sweep(paths, [engine])
    const card = (await listCards(paths, 'proposed'))[0]!
    await rejectCard(paths, card.id, '두 가격은 플랜이 달라 모순이 아니다')
    const agents = await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('두 가격은 플랜이 달라 모순이 아니다')
    expect((await listCards(paths)).find((c) => c.id === card.id)?.status).toBe('rejected')
  })

  it('반례는 롤링 20개까지만 유지된다', async () => {
    const paths = await initVault(await tmpVaultRoot('golden-rolling'), { git: false })
    const now = new Date('2026-07-01T00:00:00Z')
    for (let i = 1; i <= 25; i++) await appendCounterexample(paths, `[conflict] 반례 ${i}`, now)
    const agents = await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')
    const items = agents.slice(agents.indexOf('## Counterexamples')).split('\n').filter((l) => l.startsWith('- '))
    expect(items).toHaveLength(20)
    expect(items[0]).toContain('반례 6')
    expect(items[19]).toContain('반례 25')
  })

  it('J6 연대 추정이 pinned를 건드리지 않고 미정 노트만 채운다', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('golden-j6'))
    await sweep(paths, [engine])
    const idea = await readNote(paths, 'n-idea-0001')
    expect(idea.front.happened_at).toContain('2026-06-25')
    expect(idea.front.timeline).toBe('inferred')
    const kick = await readNote(paths, 'n-kick-0001')
    expect(kick.front.happened_at).toContain('2026-02-01')
    expect(kick.front.timeline).toBe('pinned')
  })

  it('스윕이 브리핑을 남긴다 (J8)', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('golden-j8'))
    const report = await sweep(paths, [engine])
    expect(report.briefWritten).toBe(true)
    const views = await readdir(paths.views)
    expect(views.some((f) => f.startsWith('brief-'))).toBe(true)
  })
})
