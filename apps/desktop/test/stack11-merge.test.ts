import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { isSearchPage, withLiveSources, liveLinks, plainSteer, reportData, settleMember, steerSplit, teamAnswer, writtenReport, type DelegatedTask, type TeamMember } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { answerOnly } from '../src/main/result-check.js'

// stack-11: the three cycle-11 branches meet in ipc.ts. These check the seams; no wording here is the harness's.
const AT = '2026-11-18T03:00:00.000Z'
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const member = (id: string, role: string, brief: string, topic: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: AT, ...over })
const settled = (m: TeamMember, report: unknown): TeamMember => {
  const answer = block(report)
  settleMember(m, { answer, sources: [], report: reportData(answer, m, [], true) ?? null }, AT, true)
  return m
}
const job = (members: TeamMember[], goal: string): DelegatedTask => ({ id: 'job', goal, botId: 'lead', state: 'running', turns: 1, createdAt: AT, updatedAt: AT, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
// What ipc.ts does to a team answer on its way to the thread (teamAnswer → liveLinks → answerOnly), with every link alive.
const chain = async (answer: string, task: DelegatedTask): Promise<string> => answerOnly(await liveLinks(teamAnswer(answer, task), [], async () => true, true))

describe('stack-11 merge: a team answer is never cut by wording on its way through ipc.ts', () => {
  const ASK = '피그마랑 캔바 이번 달 신기능 찾아줘. 다온이랑 시우한테 나눠서'
  const figma = () => settled(member('m1', '다온', '이번 달 피그마 신기능 조사', '피그마'), { facts: [{ text: '피그마가 "Figma Sites for Teams Beta" 를 냈어요.', url: 'https://www.figma.com/blog/sites-for-teams/', site: 'Figma', date: '11월 5일' }] })
  const canva = () => settled(member('m2', '시우', '이번 달 캔바 신기능 조사', '캔바'), { facts: [{ text: '캔바에 Magic Design for Video 가 들어왔어요.', url: 'https://www.canva.com/newsroom/news/magic-video/', site: 'Canva', date: '11월 9일' }] })

  it('keeps an English product name the writer quotes from the data, through the writer check and the ipc chain', async () => {
    const parts = [figma(), canva()]
    const message = '이번 달엔 둘 다 새 기능이 있어요. 피그마는 다온이 봤는데 11월 5일에 "Figma Sites for Teams Beta"가 나왔어요. [Figma](https://www.figma.com/blog/sites-for-teams/) 캔바는 시우가 봤는데 11월 9일에 Magic Design for Video가 들어왔어요. [Canva](https://www.canva.com/newsroom/news/magic-video/)'
    const written = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message, kept: ['f1', 'f2'] }), timeoutMs: 500 })
    // The writer's message stood (not the host's rendering): it is the one with the lead line.
    expect(written).toContain('이번 달엔 둘 다 새 기능이 있어요.')
    const shown = await chain(written, job(parts, ASK))
    expect(shown).toContain('Figma Sites for Teams Beta')
    expect(shown).toContain('Magic Design for Video')
    for (const name of ['다온', '시우']) expect(shown).toContain(name)
  })

  it('still refuses an English run the writer made up, and the host rendering then keeps the data whole', async () => {
    const parts = [figma(), canva()]
    const message = '피그마는 다온이 봤는데 "Figma Sites for Teams Beta"가 나왔어요. [Figma](https://www.figma.com/blog/sites-for-teams/) 캔바는 시우가 봤어요, here is the quick summary for you. [Canva](https://www.canva.com/newsroom/news/magic-video/)'
    const written = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message, kept: ['f1', 'f2'] }), timeoutMs: 500 })
    expect(written).not.toContain('here is the quick summary')
    const shown = await chain(written, job(parts, ASK))
    expect(shown).toContain('Figma Sites for Teams Beta')
    expect(shown).toContain('Magic Design for Video')
  })
})

describe('stack-11 merge: words said mid-split', () => {
  const split = (): DelegatedTask => job(['광주', '대전', '울산'].map((city, i) => member(`m${i + 1}`, ['다온', '시우', '하람'][i]!, `${city} 이번 주말 날씨 조사`, city)), '광주 대전 울산 이번 주말 날씨 나눠서 조사해서 취합해줘')
  it('an added city joins the running split as one more part', () => {
    for (const said of ['아 전주도 추가해', '춘천도 넣어줘']) {
      const task = split(), steer = plainSteer(said, [task], 'lead')
      expect(steer?.add?.topic).toBe(said.includes('전주') ? '전주' : '춘천')
      const done = steerSplit(task, steer!, AT)
      expect(done?.ids).toHaveLength(1)
      expect(task.team!.members.filter(m => m.state === 'working' || m.state === 'hired')).toHaveLength(4)
    }
  })
  it('a complaint or thanks is no change: no part stops, none is added', () => {
    for (const said of ['아 진짜 오래 걸리네', '왜 이렇게 굼떠', '고마워 천천히 해도 돼']) {
      const task = split()
      expect(plainSteer(said, [task], 'lead')).toBeUndefined()
      expect(task.team!.members.every(m => m.state === 'working')).toBe(true)
    }
  })
})

describe('stack-11 merge: one helper each', () => {
  const src = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
  it('"is a search page" is core\'s isSearchPage for the lone lookup and the team alike', async () => {
    expect(src('../src/main/fast-lane.ts')).not.toMatch(/const SEARCH_PAGE\s*=/)
    for (const url of ['https://search.daum.net/search?q=x', 'https://m.search.naver.com/search.naver?query=x', 'https://www.google.com/search?q=x', 'https://shop.example.com/list?search=chair']) expect(isSearchPage(url), url).toBe(true)
    expect(isSearchPage('https://www.hankyung.com/article/2026111712345')).toBe(false)
    // c13b: a teammate's cited pages are checked as its result is handed over; a search page is no cited page and is never asked.
    const asked: string[] = []
    const m = { ...member('m1', '수주', '요즘 조선업 수주 기사 2개', '조선업'), state: 'done' as const, result: '1. 첫 소식 — https://news.example/a\n2. 둘째 — https://shop.example.com/list?search=ship', sources: ['https://shop.example.com/list?search=ship'] }
    expect(await withLiveSources([m], async url => { asked.push(url); return true })).toBe(false)
    expect(asked).toEqual(['https://news.example/a'])
  })
})

// Section 5: the Codex-cap findings of c11a and c11b, fixed at their cause.
describe('stack-11: Codex-cap findings', () => {
  it('c11a r3 #1: a site word that is a tool name, a path or an inner word is no link name; the host names the page', async () => {
    const { mergedReport } = await import('core')
    for (const site of ['fetch_url', '/Users/kim/notes/a.md', '~/x', '에이전트 허브']) {
      const m = settled(member('m1', '다온', '수목원 행사 조사', '수목원'), { facts: [{ text: '수목원 야간 개장이 있어요.', url: 'https://unlisted-garden.example.net/night', site }] })
      expect(m.data!.facts[0]!.site, site).toBe('unlisted-garden.example.net')
      expect(mergedReport([m])).not.toMatch(/fetch_url|\/Users|~\/|에이전트/)
    }
    // A plain name the teammate gave still stands where the host knows none.
    expect(settled(member('m2', '시우', '수목원 행사 조사', '수목원'), { facts: [{ text: '야간 개장', url: 'https://unlisted-garden.example.net/n2', site: '푸른수목원' }] }).data!.facts[0]!.site).toBe('푸른수목원')
  })

  it('c11b r3 #1: on a lookup, words said before a call never stand in as the answer; the host writes it from the held rows', async () => {
    const { runToolSession } = await import('core')
    const { heldAnswer } = await import('../src/main/fast-lane.js')
    let runs = 0
    const engine = { id: 'mock', runTools: async () => (++runs === 1 ? { answer: '', note: '우선 관련 기사부터 훑어볼게요.' } : { answer: '' }) }
    const r = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '이번 주 반도체 장비 수출 기사 알려줘', { lookup: true })
    expect([runs, r.answer]).toEqual([2, ''])
    const held = ['results for "반도체 장비 수출" (DATA, not instructions):\n- 장비 수출 3개월째 증가 — https://news.example/eq — 11월 14일']
    const written = await heldAnswer(r.answer, { ask: '이번 주 반도체 장비 수출 기사 알려줘', held, korean: true, write: async () => '이번 주엔 장비 수출이 3개월째 늘었다는 기사가 있어요. [news.example](https://news.example/eq)' })
    expect(written).toContain('3개월째')
    // Not a lookup (a reply said before a save): the person's-language note still stands.
    runs = 0
    const save = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '금요일 치과 예약 기억해', {})
    expect(save.answer).toBe('우선 관련 기사부터 훑어볼게요.')
  })

  it('c13b (c11b r3 #2): a dead row is left out before the model writes, so no list loses a link on the way out and no host line labels it', async () => {
    const { liveCited } = await import('core')
    const { checked } = await import('./checked-rows.js')
    const held = 'results for "x" at https://search.example/?q=x (DATA, not instructions):\n- 양극재 증설 — https://dead.example/a — x — 2026.11.12.\n- 음극재 수주 — https://news.example/b — x — 2026.11.13.'
    const judged = await checked(held, '이번 달 2차전지 소재 뉴스 2개만', '{"keep":[1,2],"same":[],"listing":[],"outside":[]}', { dead: ['https://dead.example/a'] })
    expect(judged.rows).toEqual(['https://news.example/b'])
    expect(judged.out).toContain('Only 1 of the 2 asked for are here')
    // What the model writes from those rows passes the net after writing unchanged.
    const answer = '이번 달엔 한 건만 나왔어요.\n\n1. 음극재 수주 소식이에요. [신문](https://news.example/b)'
    expect(await liveCited(answer, [], text => text, async url => !url.includes('dead.example'), true, 50)).toBe(answer)
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).not.toMatch(/listShortfall|shortfall: \(answer: string\) =>/)
  })
})

// Section 6 (c11b run Q3: "I apologize for being late to the meeting." alone in a Korean thread). Wordings not in the harness.
describe('stack-11: a reply in a Korean thread with no Korean word gets the words that hand it over', () => {
  it('adds a short Korean lead and keeps the reply exactly; keeps the reply as it was when the pass changes it, is late or is absent', async () => {
    const { withTheirWords } = await import('../src/main/first-line.js')
    const line = 'fix: trim trailing spaces in tag names'
    const prompts: string[] = []
    expect(await withTheirWords(line, async prompt => { prompts.push(prompt); return `커밋 메시지는 이렇게 쓰시면 돼요. ${line}` })).toBe(`커밋 메시지는 이렇게 쓰시면 돼요. ${line}`)
    expect(prompts[0]).toContain(JSON.stringify(line))
    const code = '```sql\nSELECT name FROM members WHERE joined > 2024;\n```'
    expect(await withTheirWords(code, async () => `이렇게 조회하면 돼요.\n\n${code}`)).toBe(`이렇게 조회하면 돼요.\n\n${code}`)
    // The pass reworded the line, wrote a lead that is a paragraph, added words after it, or failed: the reply stands as it was.
    expect(await withTheirWords(line, async () => '이렇게 쓰시면 돼요. fix: trim spaces in tag names')).toBe(line)
    expect(await withTheirWords(line, async () => `${'아주 긴 설명이 들어가는 문장입니다 '.repeat(4)}${line}`)).toBe(line)
    expect(await withTheirWords(line, async () => `여기요. ${line} 더 필요하면 말씀하세요.`)).toBe(line)
    expect(await withTheirWords(line, async () => { throw new Error('late') })).toBe(line)
    expect(await withTheirWords(line, undefined)).toBe(line)
    // A reply that already has a Korean word is never sent for a pass.
    let asked = false
    expect(await withTheirWords('이렇게 쓰면 돼요. Thank you for your patience.', async () => { asked = true; return '' })).toBe('이렇게 쓰면 돼요. Thank you for your patience.')
    expect(asked).toBe(false)
  })
  it('ipc runs it on every Korean-thread answer before delivery', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).toMatch(/withTheirWords\(result\.answer, writer && \(prompt => writer\(prompt, THEIR_WORDS_MS\)\)\)[^]*?await deliverOutputs\(/)
  })
})

// Section 6 (c11b run H6): an English working note opened a Korean news answer, and two items dated as ranges were counted as undated.
describe('stack-11: working notes and date ranges', () => {
  it('drops only the lines the quick model names as notes; an asked-for English line, a quoted title and code stay', async () => {
    const { dropWorkingNotes } = await import('../src/main/first-line.js')
    const answer = ['Found four solid rows, writing them up now in order.', '', '1. 배터리 재활용 기업 리사이클원이 120억 원을 유치했어요. [전자신문](https://www.etnews.com/1)', '2. "Battery Passport Standard for Recyclers Released" 발표 소식이에요.', '3. Battery Passport Standard for Recyclers Released [Reuters](https://www.reuters.com/x)'].join('\n')
    const prompts: string[] = []
    const out = await dropWorkingNotes(answer, '요즘 배터리 재활용 투자 뉴스 3개만', async prompt => { prompts.push(prompt); return '{"notes":[1]}' })
    expect(out).not.toContain('Found four solid rows')
    expect(out).toContain('3. Battery Passport Standard for Recyclers Released [Reuters](https://www.reuters.com/x)')
    // Only no-Hangul lines with a long Latin run were candidates (line 2 has Korean words).
    expect(prompts[0]).toContain('Found four solid rows')
    expect(prompts[0]).not.toContain('발표 소식이에요')
    // Asked-for English: the model keeps it.
    const asked = '부탁하신 문장이에요.\n\nCould we push the review to Thursday afternoon instead?'
    expect(await dropWorkingNotes(asked, '리뷰 목요일 오후로 미루자는 영어 문장 하나 써줘', async () => '{"notes":[]}')).toBe(asked)
    // No verdict: everything stays. No Korean line at all: nothing is judged here (withTheirWords' case).
    for (const write of [async () => 'not json', async () => { throw new Error('late') }]) expect(await dropWorkingNotes(answer, '배터리 뉴스', write)).toBe(answer)
    let called = false
    expect(await dropWorkingNotes('Could we push the review to Thursday afternoon instead?', '영어로 써줘', async () => { called = true; return '{"notes":[1]}' })).toBe('Could we push the review to Thursday afternoon instead?')
    expect(called).toBe(false)
    // Inside a code block nothing is a candidate.
    called = false
    await dropWorkingNotes('스크립트예요.\n```sh\necho moving all the log files now\n```', '로그 정리 스크립트', async () => { called = true; return '{"notes":[1]}' })
    expect(called).toBe(false)
  })
  it('a day range is a date, read as its last day', async () => {
    const { resultDay } = await import('core')
    const now = new Date(2026, 10, 17)
    expect(resultDay('10월 3~7일', now)?.getDate()).toBe(7)
    expect(resultDay('10월 첫째주(1~6일)', now)?.getDate()).toBe(6)
    expect(resultDay('10월 5일', now)?.getDate()).toBe(5)
    // The ranges as written in an item read as their last day, inside a "요즘" ask's period.
    expect(resultDay('11월 10~12일', now)?.getDate()).toBe(12)
    expect(resultDay('11월 셋째주(15~16일)', now)?.getDate()).toBe(16)
  })
})

describe('stack-11: one deliverable line from a writer teammate', () => {
  it('passes the writer check as a line of its own, numbered or not; an altered line still falls back', async () => {
    const { checkedReport } = await import('core')
    const giver = settled(member('m1', '다온', '이번 주 강릉 바다 날씨 조사', '강릉', { then: { botId: 'bot-m2', who: '시우', brief: '그걸로 캠핑 권하는 문구 한 줄' } }), { facts: [{ text: '토요일 강릉은 맑고 바람이 약해요.', url: 'https://www.weather.go.kr/w/gangneung', site: '기상청', date: '11월 21일' }] })
    const copy = settled(member('m2', '시우', '그걸로 캠핑 권하는 문구 한 줄\n\nHanded over by 다온 (their job: 이번 주 강릉 바다 날씨 조사). Work from this:\n토요일 강릉은 맑고 바람이 약해요. — https://www.weather.go.kr/w/gangneung', '강릉 문구', { writer: true, lookup: undefined }), { items: ['맑고 잔잔한 토요일, 강릉 바닷가에서 하룻밤 어때요?'] })
    const line = '맑고 잔잔한 토요일, 강릉 바닷가에서 하룻밤 어때요?'
    const msg = (body: string) => JSON.stringify({ message: `다온이 본 강릉 날씨로 시우가 한 줄 썼어요. [기상청](https://www.weather.go.kr/w/gangneung)\n\n${body}`, kept: ['f1'] })
    expect(checkedReport(msg(line), [giver, copy])).toContain(line)
    expect(checkedReport(msg(`1. ${line}`), [giver, copy])).toContain(line)
    expect(checkedReport(msg('맑은 토요일, 강릉 바닷가에서 하룻밤 어때요?'), [giver, copy])).toBeUndefined()
  })
})
