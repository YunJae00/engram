import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCard } from '../src/cards.js'
import { MockEngine } from '../src/engine/mock.js'
import { J8_INSTRUCTION, looksLikeBriefRefusal, newCardsForBrief } from '../src/jobs/librarian.js'
import { sweep } from '../src/jobs/sweep.js'
import { createNote } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import type { VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const otherJobs = {
  J1: '{"type":"note","decay":"slow","body":"# 메모\\n\\n내용."}',
  J2: '{"links":[]}',
  J3: '{"cards":[]}',
  J4: '{"cards":[]}',
  J5: '{"cards":[]}',
  J6: '{"estimates":[]}',
  J7: '{"cards":[]}',
  J10: '# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- 메모 정리.',
} as const

const engine = new MockEngine({ ...otherJobs, J8: '# 브리핑\n\n요약.' })

async function briefFiles(paths: VaultPaths): Promise<string[]> {
  return (await readdir(paths.views)).filter((f) => f.startsWith('brief-'))
}

function payloadOf(prompt: string): Record<string, unknown> {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  if (!last) throw new Error('no json payload in prompt')
  return JSON.parse(last[1]!) as Record<string, unknown>
}

describe('sweep skipBrief token diet', () => {
  it('skipBrief:true runs no J8; a following sweep (skipBrief undefined) writes the brief', async () => {
    const paths = await initVault(await tmpVaultRoot('skip-brief'), { git: false })

    await writeFile(join(paths.inbox, 'memo-1.md'), '첫 캡처')
    const first = await sweep(paths, [engine], { skipBrief: true, now: () => new Date('2026-07-05T00:00:00Z') })
    expect(first.executed).toBeGreaterThan(0)
    expect(first.briefWritten).toBe(false)
    expect(await briefFiles(paths)).toEqual([])

    await writeFile(join(paths.inbox, 'memo-2.md'), '둘째 캡처')
    const second = await sweep(paths, [engine], { now: () => new Date('2026-07-06T00:00:00Z') })
    expect(second.executed).toBeGreaterThan(0)
    expect(second.briefWritten).toBe(true)
    expect(await briefFiles(paths)).toEqual(['brief-2026-07-06.md'])
  }, 60_000)
})

describe('J8 content-only apply', () => {
  it('writes the engine markdown verbatim to the _views brief path (no file-writing by the engine)', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-content'), { git: false })
    const scripted = new MockEngine({ ...otherJobs, J8: '# 오늘의 브리핑\n\n- supersede 1건 제안\n- stale 2건' })
    await writeFile(join(paths.inbox, 'memo.md'), '캡처')

    const report = await sweep(paths, [scripted], { now: () => new Date('2026-07-06T00:00:00Z') })
    expect(report.briefWritten).toBe(true)
    const body = await readFile(join(paths.views, 'brief-2026-07-06.md'), 'utf8')
    expect(body).toBe('# 오늘의 브리핑\n\n- supersede 1건 제안\n- stale 2건\n')
  }, 60_000)

  it('unwraps a ```markdown fenced brief instead of saving the fence', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-fenced'), { git: false })
    const scripted = new MockEngine({ ...otherJobs, J8: '```markdown\n# 브리핑\n\n요약.\n```' })
    await writeFile(join(paths.inbox, 'memo.md'), '캡처')

    await sweep(paths, [scripted], { now: () => new Date('2026-07-06T00:00:00Z') })
    const body = await readFile(join(paths.views, 'brief-2026-07-06.md'), 'utf8')
    expect(body).toBe('# 브리핑\n\n요약.\n')
    expect(body).not.toContain('```')
  }, 60_000)

  it('treats a disabled-tool apology as a failed job — no brief file, no garbage', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-refusal'), { git: false })
    const scripted = new MockEngine({ ...otherJobs, J8: '죄송합니다. 파일 쓰기 도구가 비활성화되어 브리핑을 저장할 수 없습니다.' })
    await writeFile(join(paths.inbox, 'memo.md'), '캡처')

    const report = await sweep(paths, [scripted], { now: () => new Date('2026-07-06T00:00:00Z') })
    expect(report.executed).toBeGreaterThan(0)
    expect(report.briefWritten).toBe(false)
    expect(report.failed.some((f) => f.kind === 'J8')).toBe(true)
    expect(await briefFiles(paths)).toEqual([])
  }, 60_000)

  it('refusal heuristic flags ko/en apologies but not real briefs', () => {
    expect(looksLikeBriefRefusal('파일 쓰기 도구가 비활성화되어 저장할 수 없습니다.')).toBe(true)
    expect(looksLikeBriefRefusal('I cannot write files because the tool is disabled.')).toBe(true)
    expect(looksLikeBriefRefusal('# 브리핑\n\n오늘 supersede 1건, stale 2건을 리뷰하세요.')).toBe(false)
    expect(looksLikeBriefRefusal('# Brief\n\nNothing new to review today.')).toBe(false)
  })
})

describe('J8 brief input + format contract', () => {
  it('feeds the sweep-raised cards (with note titles) into the J8 prompt and pins the three-section format', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-input'), { git: false })
    await createNote(paths, { id: 'n-budget', body: '# 예산 계획\n\n초안.' }, new Date('2026-07-01T00:00:00Z'))
    await writeFile(join(paths.inbox, 'memo.md'), '예산 업데이트')

    let j8prompt = ''
    const capture = new MockEngine({
      ...otherJobs,
      J4: '{"cards":[{"cardType":"supersede","targets":["n-budget"],"rationale":"갱신","proposed":"# 예산 계획 v2\\n\\n확정."}]}',
      J8: (prompt: string) => {
        j8prompt = prompt
        return '## 확인할 것\n\n- **예산 계획** — 갱신본으로 대체 제안됨'
      },
    })
    const report = await sweep(paths, [capture], { now: () => new Date('2026-07-06T00:00:00Z') })
    expect(report.briefWritten).toBe(true)

    expect(j8prompt).toContain('"cards"')
    expect(j8prompt).toContain('"cardType": "supersede"')
    expect(j8prompt).toContain('"title": "예산 계획"')
    expect(j8prompt).toContain(J8_INSTRUCTION)
    for (const heading of ["## Today’s briefing", "## Coming up", "## To review"]) {
      expect(j8prompt).toContain(heading)
    }
    expect(J8_INSTRUCTION).not.toContain('사서가 이번에 한 일')
  }, 60_000)

  it('carries the vault open loops into the J8 input: urgent ones in loops, the rolling week in upcoming', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-loops'), { git: false })
    const at = new Date('2026-07-01T00:00:00Z')
    await createNote(paths, { id: 'n-tax', body: '# 세금 신고\n\n미룸.', open_loop: true, due_at: '2026-07-03' }, at)
    await createNote(paths, { id: 'n-reply', body: '# 계약서 회신\n\n오늘까지.', open_loop: true, due_at: '2026-07-06' }, at)
    await createNote(paths, { id: 'n-deck', body: '# 발표 자료\n\n금요일 발표.', open_loop: true, due_at: '2026-07-10' }, at)
    await createNote(paths, { id: 'n-move', body: '# 이사 알아보기\n\n언젠가.', open_loop: true }, at)
    await createNote(paths, { id: 'n-yearend', body: '# 연말 정산\n\n한참 뒤.', open_loop: true, due_at: '2026-08-30' }, at)
    await createNote(paths, { id: 'n-port', body: '# 서버 포트\n\n8080.' }, at)
    await createNote(paths, { id: 'n-done', body: '# 끝난 일\n\n완료.', open_loop: true, status: 'superseded' }, at)
    await writeFile(join(paths.inbox, 'memo.md'), '캡처')

    let j8prompt = ''
    const capture = new MockEngine({
      ...otherJobs,
      J8: (prompt: string) => {
        j8prompt = prompt
        return "## Today’s briefing\n\n- **세금 신고** — 사흘 지남"
      },
    })
    await sweep(paths, [capture], { now: () => new Date('2026-07-06T00:00:00Z') })

    const payload = payloadOf(j8prompt)
    const loops = payload['loops'] as { title: string; days?: number }[]
    const upcoming = payload['upcoming'] as { title: string; due_at?: string }[]
    expect(loops.map((l) => l.title)).toEqual(['세금 신고', '계약서 회신', '이사 알아보기'])
    expect(loops.map((l) => l.days)).toEqual([-3, 0, undefined])
    expect(upcoming.map((l) => l.title)).toEqual(['발표 자료'])
    expect(upcoming[0]!.due_at).toBe('2026-07-10')
    const named = [...loops, ...upcoming].map((l) => l.title)
    for (const absent of ['연말 정산', '서버 포트', '끝난 일']) expect(named).not.toContain(absent)
  }, 60_000)
})

describe('newCardsForBrief', () => {
  it('diffs new cards and resolves each to its target note title, with proposed/id fallbacks', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-cards'), { git: false })
    const at = new Date('2026-07-06T00:00:00Z')
    await createNote(paths, { id: 'n-budget', body: '# 예산 계획\n\n본문.' }, at)
    const titled = await createCard(paths, { cardType: 'stale', targets: ['n-budget'], rationale: '만료', proposed: '' }, at)
    const proposed = await createCard(
      paths,
      { cardType: 'new-note', targets: [], rationale: '제안', proposed: '# 새 아이디어\n본문' },
      at,
    )
    const ghost = await createCard(paths, { cardType: 'stale', targets: ['does-not-exist'], rationale: '유령', proposed: '' }, at)

    const all = await newCardsForBrief(paths, new Set())
    const byId = new Map(all.map((c) => [c.id, c]))
    expect(byId.get(titled.id)?.title).toBe('예산 계획')
    expect(byId.get(proposed.id)?.title).toBe('새 아이디어')
    expect(byId.get(ghost.id)?.title).toBe(ghost.id)

    const excluding = await newCardsForBrief(paths, new Set([titled.id]))
    expect(excluding.some((c) => c.id === titled.id)).toBe(false)
  }, 60_000)

  it('caps the list at 10 and keeps every surfaced card titled by its target note', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-cap'), { git: false })
    const at = new Date('2026-07-06T00:00:00Z')
    for (let i = 0; i < 14; i++) {
      await createNote(paths, { id: `n-${i}`, body: `# 노트 ${i}\n\n본문.` }, at)
      await createCard(paths, { cardType: 'stale', targets: [`n-${i}`], rationale: `r${i}`, proposed: '' }, at)
    }
    const cards = await newCardsForBrief(paths, new Set())
    expect(cards).toHaveLength(10)
    expect(cards.every((c) => /^노트 \d+$/.test(c.title))).toBe(true)
  }, 60_000)

  it('folds cards touching the same notes into one issue line (lead = most consequential type)', async () => {
    const paths = await initVault(await tmpVaultRoot('brief-group'), { git: false })
    const at = new Date('2026-07-16T00:00:00Z')
    await createNote(paths, { id: 'n-old', body: '# 외부 API rate limit\n\n분당 60.' }, at)
    await createNote(paths, { id: 'n-new', body: '# rate limit 상향\n\n분당 600.' }, at)
    await createNote(paths, { id: 'n-solo', body: '# 무관한 노트\n\n본문.' }, at)
    await createCard(paths, { cardType: 'supersede', targets: ['n-old'], rationale: 'r', proposed: '# 갱신된 본문\n\n내용.' }, at)
    await createCard(paths, { cardType: 'conflict', targets: ['n-old', 'n-new'], rationale: 'r' }, at)
    await createCard(paths, { cardType: 'merge', targets: ['n-old', 'n-new'], rationale: 'r', proposed: '# 병합\n\n내용.' }, at)
    await createCard(paths, { cardType: 'stale', targets: ['n-old'], rationale: 'r', proposed: '재확인' }, at)
    await createCard(paths, { cardType: 'stale', targets: ['n-solo'], rationale: 'r', proposed: '재확인' }, at)

    const cards = await newCardsForBrief(paths, new Set())
    expect(cards).toHaveLength(2)
    const issue = cards.find((c) => c.title === '외부 API rate limit')
    expect(issue?.cardType).toBe('conflict')
    expect(issue?.related).toBe(3)
    const solo = cards.find((c) => c.title === '무관한 노트')
    expect(solo?.related).toBeUndefined()
  }, 60_000)
})
