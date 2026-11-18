import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { messageUnits } from 'core'
import { checkedDesk, withPart } from '../src/main/desk-lane.js'

const SOURCE = [
  '# 영업팀 11월 월간 회의', '',
  '## 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '',
  '## 액션', '- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일', '',
  '## 미결', '- 판촉물 업체는 다음 주에 확정한다.',
].join('\n')
const ASK = '영업팀 회의록에서 주요 결정이랑 담당자별 업무만 뽑아줘'
const DRAFT = ['영업팀 11월 회의에서 주요 결정과 담당자별 업무를 뽑았어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸'].join('\n')
const TASKS = ['- 견적 비교표 작성 — 김하준, 11월 28일', '- 대리점 공지 발송 — 오세린, 12월 2일', '- 요금제 안내 자료 — 한지호, 12월 5일', '- 설명회 장소 섭외 — 문가영, 12월 12일']
const missing = JSON.stringify({ problems: [{ kind: 'missing', quote: '담당자별 업무', why: '없어요', lines: TASKS }] })
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const quickOf = (check: (string | undefined)[], repair: (string | undefined)[]) => {
  const prompts: string[] = []
  return { prompts, quick: async (p: string) => { prompts.push(p); return p.includes(CHECK) ? check.shift() ?? '{"problems":[]}' : p.includes(REPAIR) ? repair.shift() : undefined } }
}
const draftLines = (out: string): string[] => out.split('\n').filter(line => DRAFT.split('\n').includes(line))

describe('a missing named part is inserted, never re-sorted', () => {
  it('the scoped repair adds 담당자별 업무 and every draft line stays as it was', async () => {
    const units = messageUnits(DRAFT)
    const { quick, prompts } = quickOf([missing], [JSON.stringify({ insert_after: { [String(units.length)]: ['', '담당자별 업무', ...TASKS] } })])
    const logged: string[] = []
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now(), log: (o, k) => logged.push(`${o}:${k.join(',')}`) })
    expect(out).toBe(`${DRAFT}\n\n담당자별 업무\n${TASKS.join('\n')}`)
    expect(draftLines(out).filter(Boolean)).toEqual(DRAFT.split('\n').filter(Boolean))
    expect(prompts.filter(p => p.includes(REPAIR))).toHaveLength(1)
    expect(logged).toEqual(['repaired:missing'])
  })

  it('a repair that rewrites the lead is discarded, and the host adds the part from the source lines the check named', async () => {
    const { quick } = quickOf([missing], [JSON.stringify({ replace: { '1': '회의 정리했어요.' }, insert_after: { '5': ['담당자별 업무', ...TASKS] } })])
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now() })
    expect(out.startsWith(DRAFT), out).toBe(true)
    expect(out).toContain('담당자별 업무')
    for (const task of TASKS) expect(out).toContain(task)
  })

  it('lines the check names that are not in the source are never added; with none left the draft stands', () => {
    expect(withPart(DRAFT, { quote: '담당자별 업무', lines: ['- 출장 보고서 — 김하준, 11월 30일'] }, SOURCE)).toBe(DRAFT)
    expect(withPart(DRAFT, { quote: '담당자별 업무' }, SOURCE)).toBe(DRAFT)
  })
})

describe('r2: a missing part whose lines sit under another part is moved, not skipped', () => {
  it('the tasks under 결정 move under 담당자별 업무; the decisions stay; nothing is said twice', () => {
    const misplaced = [...DRAFT.split('\n'), ...TASKS].join('\n')
    const out = withPart(misplaced, { quote: '담당자별 업무', lines: TASKS }, SOURCE)
    expect(out).toBe(`${DRAFT}\n\n담당자별 업무\n${TASKS.join('\n')}`)
    for (const task of TASKS) expect(out.split(task)).toHaveLength(2)
  })
  it('a part that held only the moved lines goes with them; a line worded a little differently is the same row', () => {
    const only = '인사팀 회의 정리했어요.\n\n채용\n- 공고 초안 작성 — 박서윤 11월 30일\n- 면접관 교육 — 이도경, 12월 3일'
    const source = '## 할 일\n- 공고 초안 작성 — 박서윤, 11월 30일\n- 면접관 교육 — 이도경, 12월 3일'
    const out = withPart(only, { quote: '할 일', lines: ['- 공고 초안 작성 — 박서윤, 11월 30일', '- 면접관 교육 — 이도경, 12월 3일'] }, source)
    expect(out).toBe('인사팀 회의 정리했어요.\n\n할 일\n- 공고 초안 작성 — 박서윤, 11월 30일\n- 면접관 교육 — 이도경, 12월 3일')
  })
})

describe('register of copied lines', () => {
  it('a copied "…확정한다." line is turned into 해요체 and every other line is byte-equal', async () => {
    const draft = `${DRAFT}\n\n미결\n- 판촉물 업체는 다음 주에 확정한다.`
    const units = messageUnits(draft)
    const register = JSON.stringify({ problems: [{ kind: 'register', quote: '판촉물 업체는 다음 주에 확정한다.', why: '한다체' }] })
    const { quick } = quickOf([register], [JSON.stringify({ replace: { [String(units.length)]: '- 판촉물 업체는 다음 주에 정해요.' } })])
    const out = await checkedDesk({ ask: ASK, draft, source: SOURCE, fromSource: true, quick, since: Date.now() })
    const before = draft.split('\n'), after = out.split('\n')
    expect(after).toHaveLength(before.length)
    after.forEach((line, i) => { if (i !== before.length - 1) expect(line).toBe(before[i]) })
    expect(after.at(-1)).toBe('- 판촉물 업체는 다음 주에 정해요.')
  })
})
