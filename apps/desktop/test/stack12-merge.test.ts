import { mkdir, mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createBot, createTask, inAskedPeriod, kindChecked, LATE_CEILING_MS, TEAM_ANSWER_MS, mergedReport, reportData, settleMember, updateTask, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamAsk } from '../src/main/fast-lane.js'
import { checked } from './checked-rows.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// stack-12: c12b (lone-lookup item verdict) and c12a (team: reserve, host-said gaps, data-led lines) meet here. No wording is the harness's.
const AT = '2026-11-18T03:00:00.000Z'
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const member = (id: string, role: string, brief: string, topic: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: AT, ...over })
const settled = (m: TeamMember, report: unknown, sources: string[] = []): TeamMember => {
  const answer = block(report)
  settleMember(m, { answer, sources, report: reportData(answer, m, sources, true) ?? null }, AT, true)
  return m
}
const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('stack-12 merge: one item judge', () => {
  it('the team kind check and the lone lookup verdict send one prompt, and each caller reads only its own fields', async () => {
    const prompts: string[] = []
    const answer = '{"keep":[1,3],"same":[[1,3]],"lists":[3],"names":{"1":"수원 재즈 공연"}}'
    const write = async (prompt: string) => { prompts.push(prompt); return answer }
    const facts = [{ text: '수원 재즈 공연이 12월 5일에 열려요.', url: 'https://a.example/1', site: 'a' }, { text: '수원 맛집 지도', url: 'https://b.example/2', site: 'b' }, { text: '수원 공연 일정 페이지예요.', url: 'https://c.example/3', site: 'c' }]
    const team = await kindChecked({ facts }, '다음 달 수원 공연 일정', write)
    const lone = await checked(['results for "수원 공연" at https://search.example/?q=s (DATA, not instructions):', ...facts.map(f => `- ${f.text} — ${f.url} — x`)].join('\n'), '수원 공연 3개 알려줘', prompt => write(prompt))
    // c13b/c15a/c16b: the lookup adds only its "asked", "search" and "open" lines and fields; every other instruction line is the same. Its short list
    // (1 of 3) asks the judge once more for other words: a third prompt.
    const instructions = (p: string) => p.split('\n').filter(line => !/^(Ask|Items): |^Give in "asked" |^When "asked" is a number|^When no item is in "holds", give in "open"/.test(line)).join('\n').replace(', "asked": <n or null>, "search": "<words>", "open": <n or null>', '')
    expect(prompts).toHaveLength(3)
    expect(instructions(prompts[0]!)).toBe(instructions(prompts[1]!))
    // kindChecked: keep, lists, names (as before the merge); the same-event groups are not its business.
    expect(team!.facts.map(f => [f.url, f.listing ?? false, f.name ?? ''])).toEqual([['https://a.example/1', false, '수원 재즈 공연'], ['https://c.example/3', true, '']])
    // c13b: the lone lookup's row check reads keep, same, lists and listing: row 3 is a page of several (lists) and the same event as row 1.
    expect(lone.rows).toEqual(['https://a.example/1'])
    expect(lone.out).toContain('1 of the 3 asked for were found')
    // No second judge is defined anywhere.
    expect(src('../../../packages/core/src/company-tools.ts')).not.toMatch(/Keep every item that is the kind of thing/)
    expect(src('../src/main/fast-lane.ts')).not.toMatch(/Judge each item by what it is/)
    expect(src('../../../packages/core/src/item-check.ts').match(/Judge each item by what it is/g)).toHaveLength(1)
  })
})

describe('stack-12 merge: time and the anonymous helpers', () => {
  it('c12b left the lookup limits as c12a\'s reserve reads them', () => {
    // c13a: one deadline from the person's message replaces the fixed 8 s / 15 s; the runner and its test seam read it.
    expect([TEAM_ANSWER_MS, LATE_CEILING_MS]).toEqual([28_000, 90_000])
    expect(src('../src/main/team-runner.ts')).toMatch(/answerMs = deps\.answerMs \?\? TEAM_ANSWER_MS/)
    expect(src('../src/main/team-runner.ts')).toMatch(/due = taskDue\(task\)/)
  })
  it('an anonymous hire_members helper gets no reserve round, no stand-in, no kind check, and a team ask no lone-lookup verdict', () => {
    const runner = src('../src/main/team-runner.ts')
    // The reserve is armed only for a teammate with a name (botId); a nameless helper's data is never structured, so nothing is judged.
    expect(runner).toMatch(/if \(me\.botId\) reserve = setTimeout\(answerNow/)
    expect(runner).toMatch(/const structured = !!me\.botId && /)
    expect(runner).toMatch(/let data = structured \? reportData/)
    // The verdict runs only on a lone lookup; a "make N bots and …" ask is a team ask.
    expect(src('../src/main/ipc.ts')).toMatch(/solo = lane && !teamAsk\(request\.message\)/)
    expect(teamAsk('봇 2개 만들어서 대전 광주 미세먼지 알아보고 합쳐줘')).toBe(true)
  })
})

describe('stack-12 merge: rule 7, a part at work or with no data is labeled (and linked when it read a page) on both paths', () => {
  const ASK = '이번 달 카카오맵, 티맵, 네이버지도 새 기능 셋이 나눠서 봐줘'
  const parts = () => [
    settled(member('m1', '라온', '이번 달 카카오맵 새 기능 조사', '카카오맵'), { facts: [{ text: '카카오맵에 실내 길찾기가 생겼어요.', url: 'https://kakao.example/notice/1', date: '11월 10일' }] }),
    member('m2', '보람', '이번 달 티맵 새 기능 조사', '티맵'),
    (() => { const m = member('m3', '세찬', '이번 달 네이버지도 새 기능 조사', '네이버지도'); settleMember(m, { answer: '', sources: ['https://navermap.example/notice'], report: null }, AT, true); return m })(),
  ]
  it('the host rendering', () => {
    const text = mergedReport(parts())
    expect(text).toContain('티맵(보람): 아직 찾는 중이에요.')
    expect(text).toMatch(/네이버지도\(세찬\): 이번엔 끝까지 못 봤어요\. 보던 곳은 \[[^\]]+\]\(https:\/\/navermap\.example\/notice\)/)
  })
  it('the writer path: the writer speaks of the parts with data, the host adds the labeled lines', async () => {
    const message = '라온이 카카오맵을 봤는데 11월 10일에 실내 길찾기가 생겼어요. [카카오](https://kakao.example/notice/1) 티맵은 보람이 아직 찾는 중이에요.'
    const text = await writtenReport({ ask: ASK, members: parts(), write: async () => JSON.stringify({ message, kept: ['f1'] }), timeoutMs: 500 })
    expect(text).toContain('실내 길찾기')
    expect(text).toContain('아직 찾는 중')
    expect(text).toMatch(/세찬\): 이번엔 끝까지 못 봤어요\. 보던 곳은 \[[^\]]+\]\(https:\/\/navermap\.example\/notice\)/)
  })
})

// --- section 5 (c12a hard-stop change): the answer reserve never outlives a stop. 3 000 ms stands for 15 s (reserve 600 ms, grace 200 ms).
describe('stack-12: a stop ends a teammate at once, even while its stand-in report is awaited', () => {
  it('stopped during the wait for the quick model\'s report, the teammate ends within a few ms, not at the limit plus grace', async () => {
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
    type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
    const run: Run = async (deps, _prompt, options = {}) => {
      options.onStart?.()
      // The answer round (no tools) comes back at once with no report block: the stand-in report is then awaited.
      if (!deps.tools.length) return { answer: '정리 중이에요.', steps: [], fellBack: false }
      await deps.tools.find(t => t.name === 'search_web')!.run({ query: '지하철 앱 11월 업데이트' }, { task: '' })
      options.onStep?.('search_web')
      return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => { ended = Date.now() }, step: () => undefined, changed: () => undefined, run, answerMs: 3_000 })
    let standIn: (() => void) | undefined
    const asked = new Promise<void>(resolve => { standIn = resolve })
    // The quick model never answers the stand-in prompt.
    const engine = { id: 'claude', quick: (prompt: string) => { if (prompt.includes('ran out of time')) standIn!(); return new Promise<string>(() => undefined) } } as unknown as TurnKit['engine']
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    const work = team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하늘', brief, topic: '지하철 앱' }] }, { task: '' })
    await asked
    await new Promise(resolve => setTimeout(resolve, 50))
    const stoppedAt = Date.now()
    await team.stop('bot-b1')
    await work.catch(() => undefined)
    await vi.waitFor(() => expect(ended).toBeGreaterThan(0), { timeout: 2_000 })
    // Without the stop the wait runs to the limit plus grace (~3.2 s from start, ~0.6 s from here).
    expect(ended - stoppedAt).toBeLessThan(250)
  }, 10_000)
})

// --- section 6 (C3, C5 targeted results; cause A/B). Wordings are not the harness's.
describe('stack-12: a find is of the time asked, and a count is of single items', () => {
  const NOW = new Date('2026-11-18T10:00:00+09:00') // a Wednesday; this week began Monday 11월 16일
  it('facts dated before a period already begun are not finds for it; with none left the newest is the latest seen', () => {
    const old = { text: '다크 모드가 생겼어요.', url: 'https://bank.example/1', site: 'b', date: '11월 2일' }
    const older = { text: '송금 한도가 바뀌었어요.', url: 'https://bank.example/2', site: 'b', date: '10월 20일' }
    const fresh = { text: '간편 인증이 추가됐어요.', url: 'https://bank.example/3', site: 'b', date: '11월 17일' }
    const undated = { text: '공지 페이지예요.', url: 'https://bank.example/4', site: 'b' }
    const brief = '이번 주 은행 앱 새 기능 조사'
    expect(inAskedPeriod({ facts: [old, older] }, brief, NOW)).toEqual({ facts: [], nothing: { latest: old } })
    expect(inAskedPeriod({ facts: [old, fresh, undated] }, brief, NOW)).toEqual({ facts: [fresh, undated] })
    // Nothing judged: no period, a period not begun yet (a coming month, its forecast dates), or no data.
    expect(inAskedPeriod({ facts: [old] }, '은행 앱 새 기능 조사', NOW)).toEqual({ facts: [old] })
    expect(inAskedPeriod({ facts: [old] }, '다음 달 은행 앱 행사 일정', NOW)).toEqual({ facts: [old] })
    expect(inAskedPeriod({ facts: [old] }, '이번 주말 부산 날씨', NOW)).toEqual({ facts: [old] })
    expect(inAskedPeriod(undefined, brief, NOW)).toBeUndefined()
    // Shown as a part that found nothing this week, with the latest and its link (rule 7), never as this week's find.
    const m = member('m1', '하람', brief, '은행 앱', { state: 'done', data: inAskedPeriod({ facts: [old, older] }, brief, NOW)! })
    const text = mergedReport([m])
    expect(text).toMatch(/이번엔 새로 나온 게 없어요\. 가장 최근 소식은 이래요\.\n다크 모드가 생겼어요 \(11월 2일\)\. \(하람\) \[[^\]]+\]\(https:\/\/bank\.example\/1\)/)
  })
  it('a listing page is shown labeled but never counted among the items', () => {
    const facts = [
      { text: '12월 4일 판교에서 클라우드 밋업이 열려요.', url: 'https://ev.example/1', site: 'e' },
      { text: '12월 11일 강남에서 보안 세미나가 열려요.', url: 'https://ev.example/2', site: 'e' },
      { text: '성남 IT 행사 모음 페이지예요.', url: 'https://ev.example/list', site: 'e', listing: true as const },
    ]
    const m = member('m1', '도담', '다음 달 성남 IT 행사 일정 정리', '성남 IT 행사 일정', { state: 'done', data: { facts } })
    const text = mergedReport([m])
    // c13a (cause H): no host count lead at all; the two single items are the list's lines, the page is labeled after them.
    expect(text).not.toMatch(/\d개/)
    expect(text.split('\n').filter(line => line.startsWith('- ') && !line.includes('여러 건이 한 페이지에'))).toHaveLength(2)
    expect(text).toContain('여러 건이 한 페이지에 모여 있어요.')
  })
})
