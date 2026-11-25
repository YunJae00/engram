import { mkdir, mkdtemp } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createBot, createTask, dateLine, handBacks, keptItems, LATE_CEILING_MS, LOOKUP_RULE, memberTask, partOutcome, TEAM_ANSWER_MS, settleMember, updateTask, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamAsk } from '../src/main/fast-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

const AT = '2026-11-18T03:00:00.000Z'
const member = (id: string, role: string, brief: string, topic: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: AT, ...over })
const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  settleMember(m, { answer, sources }, AT, true)
  return m
}
const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const CHECK_FILES: string[] = []
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const handed = (members: TeamMember[]): { reports: Report[]; note: string } => JSON.parse(handBacks(members)) as { reports: Report[]; note: string }

describe('stack-12 merge: one item judge', () => {
  it('no item judge reads a draft or a hand-back: no check file is left in core, the teammate\'s own search lives in its own file and is wired only in the team runner, and a teammate\'s lines reach the lead as written', () => {
    expect(readdirSync(new URL('../../../packages/core/src/', import.meta.url)).filter(file => /check/.test(file)).sort()).toEqual(CHECK_FILES)
    for (const file of ['../../../packages/core/src/company-tools.ts', '../../../packages/core/src/team-hire-tools.ts', '../src/main/fast-lane.ts', '../src/main/team-runner.ts', '../src/main/ipc.ts']) expect(src(file), file).not.toMatch(/Judge each item by what it is|Keep every item that is the kind of thing/)
    for (const file of ['../../../packages/core/src/company-tools.ts', '../../../packages/core/src/team-hire-tools.ts', '../src/main/fast-lane.ts', '../src/main/ipc.ts']) expect(src(file), file).not.toContain('checkedSearch')
    expect(src('../src/main/team-runner.ts')).toContain("tool.name === 'search_web' && me.lookup ? checkedSearch(tool, {")
    expect(LOOKUP_RULE).toContain('When they hold what the brief asks, report at once from them, each fact with the address of the result it came from')
    const lines = ['진주 남강 유등 전시가 12월 6일에 열려요. https://a.example/lantern', '진주 국악 한마당이 12월 13일에 열려요. https://c.example/gugak'].join('\n')
    const m = settled(member('m1', '라온', '다음 달 진주 공연 일정', '진주 공연'), lines, ['https://a.example/lantern', 'https://c.example/gugak'])
    expect(m.data).toBeUndefined()
    expect(handed([m]).reports[0]).toMatchObject({ who: '라온', part: '진주 공연', state: 'done', result: lines })
  })
})

describe('stack-12 merge: time and the anonymous helpers', () => {
  it('c12b left the lookup limits as c12a\'s reserve reads them', () => {
    expect([TEAM_ANSWER_MS, LATE_CEILING_MS]).toEqual([28_000, 90_000])
    expect(src('../src/main/team-runner.ts')).toMatch(/answerMs = deps\.answerMs \?\? TEAM_ANSWER_MS/)
    expect(src('../src/main/team-runner.ts')).toMatch(/due = taskDue\(task\)/)
  })
  it('an anonymous hire_members helper gets no reserve round, no stand-in, no kind check, and a team ask no lone-lookup verdict', () => {
    const runner = src('../src/main/team-runner.ts')
    expect(runner).toMatch(/if \(me\.botId\) reserve = setTimeout\(answerNow/)
    expect(runner).not.toMatch(/const structured/)
    expect(runner).toContain('settleMember(m, { ...outcome, ')
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/\bsolo\b|teamAsk/)
    expect(teamAsk('봇 2개 만들어서 대전 광주 미세먼지 알아보고 합쳐줘')).toBe(true)
  })
})

describe('stack-12 merge: rule 7, a part at work or with no data is labeled (and linked when it read a page) on both paths', () => {
  const READ = 'https://trailclub.example/notice'
  const parts = () => [
    settled(member('m1', '라온', '이번 달 북한산 산악회 새 일정 조사', '북한산'), '북한산 산악회가 11월 22일에 야간 산행을 열어요. https://bukhan.example/notice/1', ['https://bukhan.example/notice/1']),
    member('m2', '보람', '이번 달 관악산 산악회 새 일정 조사', '관악산'),
    settled(member('m3', '세찬', '이번 달 도봉산 산악회 새 일정 조사', '도봉산'), '', [READ]),
  ]
  it('the hand-back: the part at work is handed back as working with no words, and the part that read a page and brought nothing as failed, never as done', () => {
    const members = parts(), got = handed(members)
    expect(members.map(partOutcome)).toEqual(['found', 'working', 'unfinished'])
    expect(got.reports.map(one => [one.who, one.part, one.state, one.result])).toEqual([['라온', '북한산', 'done', '북한산 산악회가 11월 22일에 야간 산행을 열어요. https://bukhan.example/notice/1'], ['보람', '관악산', 'working', ''], ['세찬', '도봉산', 'failed', 'Failed: it ended without an answer.']])
    expect(members[2]!.state).toBe('failed')
  })
  it('the writer path: saying each such part in its place is the lead model\'s to write, told by the hand-back note and the voice rule; no host line is added', () => {
    expect(handed(parts()).note).toContain('Say plainly which part failed or is missing.')
    expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
    expect(Object.keys(JSON.parse(handBacks(parts())) as object)).toEqual(['reports', 'note'])
  })
})

describe('stack-12: a stop ends a teammate at once, even while its stand-in report is awaited', () => {
  it('stopped during the wait for the answer-now round, the teammate ends within a few ms, not at the limit plus grace', async () => {
    const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
    await mkdir(temporary, { recursive: true })
    const paths = { cache: join(await mkdtemp(join(temporary, 'engram-stack12-')), '.engram') } as unknown as VaultPaths
    for (const name of ['엔그램', '하늘']) await createBot(paths, { name })
    const brief = '이번 달 지하철 앱 업데이트 조사'
    const created = await createTask(paths, `하늘한테 맡겨: ${brief}`, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const PAGE = 'https://subway.example/notice/11'
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.naver.com/search.naver?query=x (DATA, not instructions):\n- 공지 — ${PAGE} — 혼잡도 알림 — 11월 3일` }
    let ended = 0
    let standIn: (() => void) | undefined
    const asked = new Promise<void>(resolve => { standIn = resolve })
    type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
    const run: Run = async (deps, _prompt, options = {}) => {
      options.onStart?.()
      if (!deps.tools.length) { standIn!(); return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')))) }
      await deps.tools.find(t => t.name === 'search_web')!.run({ query: '지하철 앱 11월 업데이트' }, { task: '' })
      options.onStep?.('search_web')
      return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => { ended = Date.now() }, step: () => undefined, changed: () => undefined, run, answerMs: 3_000 })
    const engine = { id: 'claude', quick: () => new Promise<string>(() => undefined) } as unknown as TurnKit['engine']
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    const work = team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하늘', brief, topic: '지하철 앱' }] }, { task: '' })
    await asked
    await new Promise(resolve => setTimeout(resolve, 50))
    const stoppedAt = Date.now()
    await team.stop('bot-b1')
    await work.catch(() => undefined)
    await vi.waitFor(() => expect(ended).toBeGreaterThan(0), { timeout: 2_000 })
    expect(ended - stoppedAt).toBeLessThan(250)
  }, 10_000)
})

describe('stack-12: a find is of the time asked, and a count is of single items', () => {
  const NOW = new Date('2026-11-18T10:00:00+09:00')
  it('the period asked reaches the teammate as dates in its task, and what it then brings is handed back as written: no host pass drops a dated line', () => {
    const brief = '이번 주 도서관 앱 새 기능 조사'
    expect(dateLine(brief, NOW)).toContain('이번 주 = 2026년 11월 16일~11월 22일: search and answer for that period')
    expect(memberTask(member('m1', '하람', brief, '도서관 앱'), '도서관 앱 소식 봐줘', undefined, [], NOW).split('\n')[0]).toBe(dateLine(`${brief} 도서관 앱 소식 봐줘`, NOW))
    expect(dateLine('도서관 앱 새 기능 조사', NOW)).not.toContain('search and answer for that period')
    expect(dateLine('다음 달 도서관 행사 일정', NOW)).toContain('다음 달 = 2026년 12월')
    const old = '11월 2일에 좌석 예약 화면이 바뀌었어요. https://lib.example/1', fresh = '11월 17일에 반납 알림이 추가됐어요. https://lib.example/3'
    const m = settled(member('m1', '하람', brief, '도서관 앱'), `${old}\n${fresh}`)
    expect(handed([m]).reports[0]!.result).toBe(`${old}\n${fresh}`)
  })
  it('a search-results page is never one of the items of a list a teammate hands back', () => {
    const brief = '다음 달 통영 책 잔치 일정 목록'
    const items = ['- 12월 4일 통영 시립도서관에서 낭독회가 열려요. https://ev.example/1', '- 12월 11일 강구안 책방에서 저자와의 만남이 열려요. https://ev.example/2']
    const listing = '- 통영 책 행사 모음이에요. https://search.naver.com/search.naver?query=x'
    expect(keptItems(brief, [...items, listing].join('\n'))).toBe(items.join('\n'))
    const m = settled(member('m1', '도담', brief, '통영 책 행사'), [...items, listing].join('\n'))
    expect(handed([m]).reports[0]!.result.split('\n')).toEqual(items)
    expect(keptItems('통영 책 행사 분위기 알려줘', [...items, listing].join('\n'))).toBe([...items, listing].join('\n'))
  })
})
