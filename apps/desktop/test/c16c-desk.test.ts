import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { checkedDesk, DESK_NOTE, reshapeAsk, reshapePrompt, withoutQuoted } from '../src/main/desk-lane.js'

// c16c (cause D2): desk and reshape answers were checked for how things are said, never for what the ask named (its parts, its facts).
// Wordings are not the harness's: a kickoff memo whose own "## 합의" heading lists tasks; a late-parcel apology made simpler.
const SOURCE = '# 킥오프 메모\n\n## 이야기한 것\n- 출시는 3월로 가자는 데 모두 동의했다.\n- 외주 디자이너 일정이 밀리면 출시가 늦어질 수 있다.\n\n## 합의\n1. 요구사항 문서 작성 — 담당: 이수진, 기한: 12월 5일\n2. 디자이너 계약 — 담당: 박준호, 기한: 12월 8일\n'
const ASK = '프로젝트 킥오프 메모 정리해서 합의된 것, 리스크, 다음 단계로 나눠줘'
const DRAFT = '합의된 것\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일'
const FIXED = '합의된 것\n- 출시는 3월\n\n리스크\n- 디자이너 일정이 밀리면 출시가 늦어질 수 있어요\n\n다음 단계\n- 요구사항 문서 작성 — 이수진, 12월 5일\n- 디자이너 계약 — 박준호, 12월 8일'
const missing = JSON.stringify({ problems: [{ kind: 'missing', quote: '리스크', why: '리스크 부분이 없어요' }] })

describe('a part the ask names and the answer lacks is "missing" (D1 class)', () => {
  it('the check asks for it, the one rewrite is told to give every named part, and the rewrite with all three parts is shown', async () => {
    const prompts: string[] = []
    const said = [missing, FIXED, '{"problems":[]}']
    const logged: string[] = []
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick: async (p: string) => { prompts.push(p); return said.shift() }, since: Date.now(), log: (o, k) => logged.push(`${o}:${k.join(',')}`) })
    expect(out).toBe(FIXED)
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('"missing"')
    expect(prompts[1]).toContain('Every part the person named is its own part')
    expect(prompts[1]).toContain('"missing"')
    for (const part of ['합의된 것', '리스크', '다음 단계']) expect(out).toContain(part)
    expect(logged).toEqual(['rewritten:missing'])
  })
  it('a rewrite that fails leaves the draft as it was: a missing part is never a reason to withhold the answer', async () => {
    const said = [missing, undefined]
    expect(await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick: async () => said.shift(), since: Date.now() })).toBe(DRAFT)
    const still = [missing, DRAFT.replace('12월 8일', '12월 9일'), missing]
    expect(await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick: async () => still.shift(), since: Date.now() })).toBe(DRAFT.replace('12월 8일', '12월 9일'))
    // The quote is the part's name: no line is taken out, even one that holds those words.
    expect(withoutQuoted('다음 단계\n- 다음 단계 일정 잡기', [{ kind: 'missing', quote: '다음 단계', why: '' }])).toBe('다음 단계\n- 다음 단계 일정 잡기')
  })
  it('the desk note gives the parts the ask names, filled by meaning over the source\'s headings', () => {
    expect(DESK_NOTE).toContain('When they name the parts of the answer')
    expect(DESK_NOTE).toContain('even when the source labels it otherwise')
  })
})

describe('a reshape keeps the facts of the earlier ask (Q4 class)', () => {
  const EARLIER = '"택배 늦게 보내서 죄송합니다"를 정중한 영어 한 줄로 써줘'
  const LAST = '이렇게 쓰시면 돼요. "I sincerely apologize for the delay in sending your package."'
  const was = 'I sincerely apologize for the delay in sending your package.'
  const say = (reply: string): string => JSON.stringify({ form: 'simpler', was, reply })
  const lost = 'I apologize for the delay.', kept = 'Sorry your package was sent late.'
  it('the voice is told that simpler removes words, never a fact the ask put in', () => {
    const prompt = reshapePrompt('더 간단히', LAST, EARLIER)
    expect(prompt).toContain('Every fact the person had put in their ask (who, what, for what, when)')
    expect(reshapePrompt('더 간단히', LAST)).not.toContain('Every fact the person had put in')
  })
  it('a reply without the parcel is "dropped" and rewritten; the check names facts in its "dropped" line', async () => {
    const calls: string[] = []
    const verdicts = [JSON.stringify({ problems: [{ kind: 'dropped', quote: lost, why: '택배가 빠졌어요' }] }), '{"problems":[]}']
    const quick = async (p: string): Promise<string> => { calls.push(p); return p.includes('Judge meaning only') ? verdicts.shift()! : p.includes('Your earlier draft was') ? say(kept) : say(lost) }
    expect(await reshapeAsk('더 간단히', LAST, quick, EARLIER)).toBe(kept)
    expect(calls[1]).toContain('a fact the earlier ask itself put in (who, what, for what, when)')
    expect(calls).toHaveLength(4)
  })
})

// c16c r2 (Codex r1 #1): a one-line draft skipped the check by its line count, so a one-line answer to an ask naming two parts went out
// with one of them missing. Wordings not the harness's: a workshop memo asked as 원인 and 대책.
describe('a one-line answer drawn from a named file is checked too (Codex r1 #1)', () => {
  const memo = '# 워크숍 메모\n- 배포가 늦어진 건 테스트 서버가 하루 내내 꺼져 있어서였다.\n- 앞으로 테스트 서버 상태를 매일 아침 확인하기로 했다 — 담당: 오하늘'
  const ask = '워크숍 메모 원인이랑 대책으로 나눠서 정리해줘'
  const oneLine = '배포가 늦어진 건 테스트 서버가 하루 꺼져 있어서였어요.'
  const fixed = '원인: 테스트 서버가 하루 내내 꺼져 있었어요.\n대책: 오하늘 님이 매일 아침 서버 상태를 확인해요.'
  const lacks = JSON.stringify({ problems: [{ kind: 'missing', quote: '대책', why: '대책이 없어요' }] })
  it('the check reads it, finds the named part missing, and the rewrite with both parts is shown', async () => {
    const said = [lacks, fixed, '{"problems":[]}'], prompts: string[] = []
    const out = await checkedDesk({ ask, draft: oneLine, source: memo, fromSource: true, quick: async (p: string) => { prompts.push(p); return said.shift() }, since: Date.now() })
    expect(out).toBe(fixed)
    expect(prompts[0]).toContain('"missing"')
    expect(prompts[1]).toContain('save the room a missing part needs')
  })
  it('a one-line short-ask answer (no named source) is still delivered without a check', async () => {
    const quick = vi.fn(async () => lacks)
    expect(await checkedDesk({ ask: '하루는 몇 분이야?', draft: '하루는 1,440분이에요.', source: '', quick, since: Date.now() })).toBe('하루는 1,440분이에요.')
    expect(quick).not.toHaveBeenCalled()
  })
})
