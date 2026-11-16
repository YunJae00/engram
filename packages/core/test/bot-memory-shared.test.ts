import { describe, expect, it, vi } from 'vitest'
import { isIdentityFact, MEMORY_BUDGET, renderMemory, scopeFacts, selectForPrompt, type BotFact } from '../src/bot-memory.js'
import { keepInMindTool } from '../src/learning-tools.js'

const NOW = new Date('2026-11-10T00:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const facts = (prefix: string, count: number, size: number): BotFact[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix}${i} ${'x'.repeat(size)}`, at: day(count - i), touchedAt: day(i) }))

describe('scopeFacts', () => {
  it('routes marked lines, strips the marker and keeps a sentence marked both ways once, shared', () => {
    expect(scopeFacts('- Everyone: 결정: A\n- this bot: 결정: A', [])).toEqual({ shared: ['결정: A'], own: [] })
    expect(scopeFacts('* everyone: 보고서는 표로 받는 걸 좋아한다\n- THIS BOT: 사내 포털은 4층 담당이다', [])).toEqual({ shared: ['보고서는 표로 받는 걸 좋아한다'], own: ['사내 포털은 4층 담당이다'] })
    expect(scopeFacts('- everyone: 결정: A\n- this bot: 결정: B', ['결정: A'])).toEqual({ shared: [], own: ['결정: B'] })
  })

  it('falls back to Korean identity phrases for unmarked lines', () => {
    expect(isIdentityFact('선호하는 호칭은 윤재님')).toBe(true)
    expect(isIdentityFact('시간대는 서울이다')).toBe(true)
    expect(isIdentityFact('타임존은 KST')).toBe(true)
    expect(scopeFacts('- 이름은 윤재라고 불러 달라고 했다', [])).toEqual({ shared: ['이름은 윤재라고 불러 달라고 했다'], own: [] })
    expect(scopeFacts('- 사무실은 4층이다', [])).toEqual({ shared: [], own: ['사무실은 4층이다'] })
  })

  it('never keeps a secret in either scope', () => {
    expect(scopeFacts('- everyone: 회사 비밀번호는 Abc12345\n- this bot: token: abcdef123', [])).toEqual({ shared: [], own: [] })
  })
})

describe('keep_in_mind scope', () => {
  it('defaults to everyone and passes this bot through', async () => {
    const keep = vi.fn(async () => undefined)
    const tool = keepInMindTool({ keep })
    await tool.run({ facts: ['보고서는 표로 받는다'] }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['보고서는 표로 받는다'], 'everyone')
    await tool.run({ facts: ['포털은 portal.example 이다'], scope: 'this bot' }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['포털은 portal.example 이다'], 'this bot')
    await tool.run({ facts: ['다른 값'], scope: 'nobody' }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['다른 값'], 'everyone')
    await tool.run({ facts: ['프로젝트 코드명은 은하호다'], replaces: ['북극성'] }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['프로젝트 코드명은 은하호다'], 'everyone', ['북극성'])
    await expect(tool.run({ facts: ['Use the key sk-abcdefghijklmnopqrstuvwxyz123456'] }, { task: '' })).rejects.toThrow('key')
  })
})

describe('prompt budget per layer', () => {
  const split = (shared: BotFact[], own: BotFact[]) => {
    const chosen = selectForPrompt({ facts: [...shared, ...own], turns: 1, shared: shared.length }, NOW)
    const ids = new Set(shared.map((f) => f.id))
    return { all: chosen, shared: chosen.filter((f) => ids.has(f.id)), own: chosen.filter((f) => !ids.has(f.id)) }
  }
  const rendered = (list: BotFact[]) => renderMemory({ facts: list, turns: 1, shared: list.length }, NOW).length

  it('caps shared at 14 lines and 1200 chars, own at 8 lines and 600 chars', () => {
    expect(split(facts('s', 20, 60), []).shared).toHaveLength(MEMORY_BUDGET.shared.lines)
    const longShared = split(facts('s', 10, 150), []).shared
    expect(longShared.length).toBeGreaterThan(0)
    expect(rendered(longShared)).toBeLessThanOrEqual(1200)
    expect(split([], facts('b', 12, 50)).own).toHaveLength(MEMORY_BUDGET.own.lines)
    const longOwn = split([], facts('b', 6, 150)).own
    expect(longOwn.length).toBeGreaterThan(0)
    expect(rendered(longOwn)).toBeLessThanOrEqual(600)
    expect(MEMORY_BUDGET).toEqual({ shared: { chars: 1200, lines: 14 }, own: { chars: 600, lines: 8 } })
  })

  it('a full shared layer leaves the own budget intact, shared first, each layer by first written', () => {
    const { all, shared, own } = split(facts('s', 20, 60), facts('b', 12, 50))
    expect(shared).toHaveLength(14)
    expect(own).toHaveLength(8)
    expect(all.slice(0, 14)).toEqual(shared)
    expect(shared.map((f) => f.at)).toEqual(shared.map((f) => f.at).sort())
    expect(own.map((f) => f.at)).toEqual(own.map((f) => f.at).sort())
  })
})

// QA145 S12/S19: what the extractor wrote when it answered the chat instead of the job.
describe('qa145 memory pollution', () => {
  it('keeps nothing from a reply that is an answer, not a list of facts', () => {
    const derailed = '# 도구를 사용하겠습니다\n<execute>\n<command>date</command>\n</execute>\n지금 **오후 2시 정도**예요.\n## COMET-REMEMBER\n- 채팅 이름은 기다릴게요'
    expect(scopeFacts(derailed, [])).toEqual({ shared: [], own: [] })
    const table = ['- 수정된 구조:', '- | 날짜 | 항목 | 금액 |', '- |---|---|---|', '- 날짜 열 추가', '- 합계 수식 조정됨', '- 더 고칠까요?', '- 합계를 금액 열로 옮김'].join('\n')
    expect(scopeFacts(table, [])).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: # 답변\n- this bot: | 사과 | 1000 |\n- this bot: 항목 더 추가할까요?\n- everyone: 팀 코드명은 은하수다', [])).toEqual({ shared: ['팀 코드명은 은하수다'], own: [] })
  })

  it('r2: a promise, an offer or an order the person never gave is not a fact', () => {
    for (const junk of ['스프린트 마감 바뀌면 알려줄게', '팀 코드명(은하수)을 문서에 포함시킬 것', '표로 정리해 드릴게요.', '초안을 다시 만들어 드리겠습니다', '코드명도 문서에 넣어 주세요', "I'll let you know when the deadline moves"])
      expect(scopeFacts(`- everyone: ${junk}`, [], '기억해 줘. 우리 팀 코드명은 은하수야.')).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: 스프린트 마감 바뀌면 알려줄게\n- everyone: 팀 코드명은 은하수다\n- everyone: 다음 스프린트 마감은 11월 25일이다', []).shared).toEqual(['팀 코드명은 은하수다', '다음 스프린트 마감은 11월 25일이다'])
    // The same wording is kept when the person set it as a standing rule.
    expect(scopeFacts('- everyone: 보고서에는 팀 코드명을 포함시킬 것', [], '앞으로 보고서에는 항상 팀 코드명을 넣어 줘').shared).toEqual(['보고서에는 팀 코드명을 포함시킬 것'])
    expect(scopeFacts('- everyone: 보고서는 표로 받는 걸 좋아한다\n- everyone: 결정: 배포는 목요일 오후에만 한다', []).shared).toHaveLength(2)
  })

  it('r3: a standing-rule word elsewhere in the message does not admit a rule the person never gave', () => {
    const rule = '- everyone: 팀 코드명(은하수)을 문서에 포함시킬 것'
    expect(scopeFacts(rule, [], '앞으로 스프린트 마감은 11월 25일이야.')).toEqual({ shared: [], own: [] })
    expect(scopeFacts(rule, [], '우리 팀 코드명은 은하수야. 문서는 내가 쓸게. 앞으로 스프린트 마감은 11월 25일이야.')).toEqual({ shared: [], own: [] })
    expect(scopeFacts(`${rule}\n- everyone: 다음 스프린트 마감은 11월 25일이다`, [], '앞으로 스프린트 마감은 11월 25일이야.').shared).toEqual(['다음 스프린트 마감은 11월 25일이다'])
    expect(scopeFacts('- everyone: Make sure the code name is in every report', [], 'The deadline is always on Friday.')).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: Make sure the code name is in every report', [], 'From now on put the code name in every report.').shared).toHaveLength(1)
  })

  it('r3: an outdated line is ignored when no replacement was kept', () => {
    const kept = ['다음 스프린트 마감은 11월 25일이다']
    expect(scopeFacts('- everyone: 스프린트 마감 바뀌면 알려줄게\n- outdated: 다음 스프린트 마감은 11월 25일이다', kept)).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- outdated: 다음 스프린트 마감은 11월 25일이다', kept)).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: 다음 스프린트 마감은 11월 27일이다\n- outdated: 다음 스프린트 마감은 11월 25일이다', kept)).toEqual({ shared: ['다음 스프린트 마감은 11월 27일이다'], own: [], outdated: kept })
  })

  it('names a kept line outdated only when it is really kept', () => {
    expect(scopeFacts('- everyone: 팀 코드명은 노을이다\n- outdated: 팀 코드명은 은하수다\n- outdated: 없는 줄', ['팀 코드명은 은하수다'])).toEqual({ shared: ['팀 코드명은 노을이다'], own: [], outdated: ['팀 코드명은 은하수다'] })
  })

  it('qa146: an outdated line deletes only what a kept line about the same subject replaces', () => {
    const deadline = ['다음 스프린트 마감은 11월 25일이다']
    // The codex repro: an unrelated new fact must not take the deadline with it.
    expect(scopeFacts('- everyone: 팀 코드명은 은하수다\n- outdated: 다음 스프린트 마감은 11월 25일이다', deadline, '우리 팀 코드명은 은하수야.')).toEqual({ shared: ['팀 코드명은 은하수다'], own: [] })
    expect(scopeFacts('- everyone: 다음 스프린트 마감은 11월 27일이다\n- outdated: 다음 스프린트 마감은 11월 25일이다', deadline).outdated).toEqual(deadline)
    // The kept line copied without its quotes or full stop is still that line.
    expect(scopeFacts('- everyone: 프로젝트 코드명은 은하호다\n- outdated: 출시 제품의 코드명은 북극성이다.', ['출시 제품의 코드명은 "북극성"이다']).outdated).toEqual(['출시 제품의 코드명은 "북극성"이다'])
    // A line that only talks about the discarded value is not a replacement, and is not kept.
    expect(scopeFacts('- everyone: TeStCode는 오타이므로 사용 금지\n- outdated: 다음 스프린트 마감은 11월 25일이다', deadline)).toEqual({ shared: [], own: [] })
  })

  it('qa146 r2: an outdated line is honoured only for the same property, not for another event of the same project', () => {
    const kickoff = ['은하호 프로젝트의 킥오프 일정은 11월 28일이다']
    expect(scopeFacts('- everyone: 은하호 프로젝트의 출시일은 12월 5일이다\n- outdated: 은하호 프로젝트의 킥오프 일정은 11월 28일이다', kickoff)).toEqual({ shared: ['은하호 프로젝트의 출시일은 12월 5일이다'], own: [] })
    expect(scopeFacts('- everyone: 은하호 프로젝트의 킥오프 일정은 12월 1일이다\n- outdated: 은하호 프로젝트의 킥오프 일정은 11월 28일이다', kickoff).outdated).toEqual(kickoff)
  })

  it('qa146 r3: an outdated line cannot remove the same property of another named project', () => {
    const other = ['은하호 프로젝트의 출시일은 11월 28일이다']
    expect(scopeFacts('- everyone: 별빛 프로젝트의 출시일은 12월 5일이다\n- outdated: 은하호 프로젝트의 출시일은 11월 28일이다', other)).toEqual({ shared: ['별빛 프로젝트의 출시일은 12월 5일이다'], own: [] })
    // An owner given without a name still matches.
    expect(scopeFacts('- everyone: 프로젝트 출시일은 12월 5일이다\n- outdated: 은하호 프로젝트의 출시일은 11월 28일이다', other).outdated).toEqual(other)
  })

  it('qa146 r2: what the comet found out about the app or a file is not a fact about the person', () => {
    expect(scopeFacts('- everyone: 앱 보관 폴더의 이전 버전 파일은 삭제가 불가능하다\n- everyone: 사용자메모 파일은 workspace 폴더에 있다', [], '파일을 만들어 줘')).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: Office app cannot delete archived files', [], '보고서를 정리해 줘')).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: Office app cannot delete archived files', [])).toEqual({ shared: [], own: [] })
    // An ordinary fact about the person is kept whatever they typed this turn, in either language.
    for (const fact of ['Their preferred pronouns are she/her', 'Preferred name: Yun', 'Their time zone is KST', '사용자의 시간대는 KST다', '11월 지출 합계는 120만원이다'])
      expect(scopeFacts(`- everyone: ${fact}`, [], '보고서를 정리해 줘').shared).toEqual([fact])
    // What the person said themselves stays, a file they placed included.
    const told: [string, string][] = [
      ['사용자의 팀 이름은 은하수입니다', '기억해 줘. 우리 팀 이름은 은하수야.'],
      ['다음 스프린트 마감은 11월 25일이다', '스프린트 마감이 11월 25일로 바뀌었어'],
      ['프로젝트 코드명은 은하호다', '코드명은 은하호로 바꿨어'],
      ['은하호 프로젝트의 출시일은 12월 5일이다', '아니, 출시는 12월 5일이야'],
      ['할 일: 민호가 API 문서를 12월 3일까지 작업합니다', '민호 API 문서 마감은 12월 3일이야'],
      ['사용자메모 파일은 workspace 폴더에 둔다', '사용자메모 파일은 항상 workspace 폴더에 둬'],
      ['Prefers totals in EUR', '합계는 유로로 보여 줘'],
    ]
    for (const [fact, said] of told) expect(scopeFacts(`- everyone: ${fact}`, [], said).shared).toEqual([fact])
  })

  it('qa146: a one-off request and the comet reporting its own work are not facts about the person', () => {
    const said = '보고서를 워드 파일로 만들어 줘. 관련 앱을 열지 말고 저장만 해줘.'
    for (const junk of ['파일을 만들 때는 관련 앱을 열지 말고 저장만 해줘', '메모 마감 12/03이 11/28 출시 목표와 다른 것을 확인했어요', '작업 중에는 워드를 열지 마세요'])
      expect(scopeFacts(`- everyone: ${junk}`, [], said)).toEqual({ shared: [], own: [] })
    expect(scopeFacts('- everyone: 파일을 만들 때는 관련 앱을 열지 말고 저장만 해줘', [], '앞으로 파일을 만들 때는 관련 앱을 열지 말고 저장만 해줘').shared).toHaveLength(1)
  })
})
