import { beforeEach, describe, expect, it } from 'vitest'
import { approveCard, createCard, listCards, rejectCard } from '../src/cards.js'
import { buildJ13, closureCandidates } from '../src/jobs/closure.js'
import { createNote, readNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const EARLIER = new Date('2026-07-28T00:00:00Z')
const NOW = new Date('2026-07-30T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('closure'), { git: false })
})

const loopOf = (id: string, body: string, origin?: 'session') =>
  createNote(paths, { id, body, open_loop: true, origin }, EARLIER)
const conclusionOf = (id: string, body: string) => createNote(paths, { id, body, origin: 'session' }, NOW)

describe('closureCandidates', () => {
  it('pairs open loops with session conclusions new since the last sweep', async () => {
    await loopOf('n-loop-a', '# 포팅 마무리\n\n다운로드 버튼 회귀 수정이 남음.')
    await conclusionOf('n-sess-a', '# 세션 결론\n\n다운로드 버튼 회귀 수정 완료, dev 배포까지 확인.')
    // A session note from BEFORE the window is not "what just happened".
    await createNote(paths, { id: 'n-sess-old', body: '# 옛 결론\n\n무관.', origin: 'session' }, EARLIER)
    const all = [await readNote(paths, 'n-loop-a'), await readNote(paths, 'n-sess-a'), await readNote(paths, 'n-sess-old')]
    const picked = closureCandidates(all, new Set(), EARLIER.toISOString(), NOW)
    expect(picked.loops.map((n) => n.front.id)).toEqual(['n-loop-a'])
    expect(picked.conclusions.map((n) => n.front.id)).toEqual(['n-sess-a'])
  })

  it('A USER NOTE IS NEVER EVIDENCE — only session-origin conclusions qualify', async () => {
    await loopOf('n-loop-b', '# 열린 고리\n\n본문.')
    await createNote(paths, { id: 'n-mine', body: '# 내가 쓴 노트\n\n그거 끝냈다.' }, NOW)
    const all = [await readNote(paths, 'n-loop-b'), await readNote(paths, 'n-mine')]
    expect(closureCandidates(all, new Set(), null, NOW).conclusions).toHaveLength(0)
  })

  it('a loop already carrying a pending closure card is not re-judged', async () => {
    await loopOf('n-loop-c', '# 고리\n\n본문.')
    const all = [await readNote(paths, 'n-loop-c')]
    expect(closureCandidates(all, new Set(['n-loop-c']), null, NOW).loops).toHaveLength(0)
  })
})

describe('what a verdict may do', () => {
  const applyVerdict = async (closures: unknown) => {
    const loops = [await readNote(paths, 'n-loop')]
    const conclusions = [await readNote(paths, 'n-done')]
    const job = buildJ13(paths, '', { loops, conclusions }, NOW)
    return job.apply(JSON.stringify({ closures }))
  }

  it("closes the machine's own loop by itself, with a journal line", async () => {
    await loopOf('n-loop', '# 세션이 연 고리\n\n마이그레이션 반영 확인 필요.', 'session')
    await conclusionOf('n-done', '# 세션 결론\n\n마이그레이션 반영 확인 완료.')
    const effects = await applyVerdict([{ loop: 'n-loop', closed_by: 'n-done', reason: '확인 완료가 명시됨' }])
    expect(effects[0]).toContain('loop closed')
    expect((await readNote(paths, 'n-loop')).front.open_loop).toBe(false)
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
  })

  it("THE USER'S LOOP GETS A QUESTION, NOT AN EDIT", async () => {
    await loopOf('n-loop', '# 내가 적어둔 약속\n\n리뷰 반영할 것.')
    await conclusionOf('n-done', '# 세션 결론\n\n리뷰 반영 완료, 머지됨.')
    const effects = await applyVerdict([{ loop: 'n-loop', closed_by: 'n-done', reason: '머지 명시' }])
    expect(effects[0]).toContain('closure proposed')
    // The loop still asks — only the user's click may close it.
    expect((await readNote(paths, 'n-loop')).front.open_loop).toBe(true)
    const cards = await listCards(paths, 'proposed')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.cardType).toBe('closure')
    expect(cards[0]!.targets).toEqual(['n-loop'])
    expect(cards[0]!.proposed).toBe('n-done')
    // A re-run proposing the same closure lands on the same card, not a twin.
    await applyVerdict([{ loop: 'n-loop', closed_by: 'n-done', reason: '재실행' }])
    expect(await listCards(paths, 'proposed')).toHaveLength(1)
  })

  it('refuses invented ids, self-closure, and evidence older than the promise', async () => {
    await loopOf('n-loop', '# 고리\n\n본문.')
    await conclusionOf('n-done', '# 결론\n\n무관한 내용.')
    const effects = await applyVerdict([
      { loop: 'n-ghost', closed_by: 'n-done', reason: '고리 id 발명' },
      { loop: 'n-loop', closed_by: 'n-ghost', reason: '증거 id 발명' },
      { loop: 'n-loop', closed_by: 'n-loop', reason: '자기 자신' },
    ])
    expect(effects).toEqual(['no loops to close'])
    expect((await readNote(paths, 'n-loop')).front.open_loop).toBe(true)
    // Evidence created BEFORE the loop cannot fulfil it: rebuild the pair with
    // the conclusion older than the loop and assert the guard holds.
    const olderEvidence = await createNote(
      paths,
      { id: 'n-early', body: '# 이른 결론\n\n끝냈다.', origin: 'session' },
      new Date('2026-07-27T00:00:00Z'),
    )
    const loops = [await readNote(paths, 'n-loop')]
    const job = buildJ13(paths, '', { loops, conclusions: [olderEvidence] }, NOW)
    const guarded = await job.apply(
      JSON.stringify({ closures: [{ loop: 'n-loop', closed_by: 'n-early', reason: '시간 역행' }] }),
    )
    expect(guarded).toEqual(['no loops to close'])
    expect((await readNote(paths, 'n-loop')).front.open_loop).toBe(true)
  })
})

describe('the closure card itself', () => {
  it('approve closes the loop; reject leaves it asking', async () => {
    await loopOf('n-loop-x', '# 약속 하나\n\n본문.')
    await loopOf('n-loop-y', '# 약속 둘\n\n본문.')
    const a = await createCard(
      paths,
      { cardType: 'closure', targets: ['n-loop-x'], rationale: '완료 증거', proposed: 'n-ev', job: 'J13' },
      NOW,
    )
    const b = await createCard(
      paths,
      { cardType: 'closure', targets: ['n-loop-y'], rationale: '완료 증거', proposed: 'n-ev', job: 'J13' },
      NOW,
    )
    await approveCard(paths, a.id, {}, NOW)
    expect((await readNote(paths, 'n-loop-x')).front.open_loop).toBe(false)
    await rejectCard(paths, b.id, '아직 안 끝남', NOW)
    expect((await readNote(paths, 'n-loop-y')).front.open_loop).toBe(true)
  })
})
