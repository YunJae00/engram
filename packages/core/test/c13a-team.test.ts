import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { HOST_TODAY } from '../src/comet-navigation-tools.js'
import { companyStatus, employeeWriteBack, inAskedPeriod, kindChecked, mergedReport, partOutcome, reportCheck, reportPrompt, teamRecord, teamSummary } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { newsPeriod, periodSince } from '../src/search-template.js'
import { dateLine, periodSpans } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// c13a: causes T and H (team side) and the team side of J. Wordings are not the harness's: 피그마 / 캔바 / 미로 updates, 대전 공연,
// 부산 전시, teammates 하람 / 이든 / 소율.
const WED = new Date(2026, 10, 18, 10, 0) // a Wednesday; this week began Monday 11월 16일
const SAT = new Date(2026, 10, 21, 15, 0) // the Saturday of that week
const at = new Date(WED.getTime() - 5_000).toISOString()
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'done', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
const fact = (text: string, url: string, date?: string) => ({ text, url, site: new URL(url).host, ...(date ? { date } : {}) })
const LINK = /\[[^\]]+\]\(https?:\/\/[^)]+\)/

test('no process sentence: the host\'s rendering of a two-teammate job is the items, each part attributed and linked, never a count or a "who brought" lead', () => {
  const figma = member({ id: 'm1', role: '하람', brief: '이번 주 피그마 업데이트 조사', topic: '피그마', data: { facts: [fact('피그마에 슬라이드 자동 정렬이 생겼어요.', 'https://www.figma.com/release-notes/1', '11월 17일'), fact('피그마 개발 모드에 코드 연결이 추가됐어요.', 'https://www.figma.com/release-notes/2', '11월 16일')] } })
  const canva = member({ id: 'm2', role: '이든', brief: '이번 주 캔바 업데이트 조사', topic: '캔바', data: { facts: [fact('캔바가 표 데이터로 차트를 만드는 기능을 냈어요.', 'https://www.canva.com/newsroom/1', '11월 18일')] } })
  for (const parts of [[figma, canva], [{ ...figma, topic: undefined }, { ...canva, topic: undefined }]]) {
    const text = mergedReport(parts), lines = text.split('\n').filter(line => line.trim())
    // Structure, not phrases: every line is an item (a link on it) or a part's row label; the first line is never a sentence of its own.
    for (const line of lines) expect(LINK.test(line) || /^\S+\(\S+\):$/.test(line), line).toBe(true)
    expect(LINK.test(lines[0]!) || /^\S+\(\S+\):$/.test(lines[0]!)).toBe(true)
    // Each teammate is named once, as attribution in parentheses.
    for (const who of ['하람', '이든']) expect(text.match(new RegExp(`\\(${who}[):]`, 'g'))).toHaveLength(1)
    // No number of things anywhere the data did not hold.
    expect(text.replace(/\]\([^)]*\)/g, ']').replace(/\d+월 \d+일/g, '')).not.toMatch(/\d/)
  }
})

test('the writer is given who, how many and each part\'s outcome as data, and leads with the answer', () => {
  const done = member({ id: 'm1', role: '하람', brief: '이번 주 피그마 업데이트 3개 조사', topic: '피그마', data: { facts: [fact('피그마에 슬라이드 자동 정렬이 생겼어요.', 'https://www.figma.com/release-notes/1')] } })
  const still = member({ id: 'm2', role: '이든', brief: '이번 주 미로 업데이트 조사', topic: '미로', state: 'working', sources: ['https://miro.com/changelog/'] })
  const prompt = reportPrompt('피그마, 미로 이번 주 업데이트 알려줘', [done, still], new Map(), { now: WED })
  const data = JSON.parse(prompt.split('Data: ')[1]!) as Record<string, unknown>[]
  expect(data[0]).toMatchObject({ name: '하람', outcome: 'found', found: 1, asked: 3 })
  expect(data[1]).toMatchObject({ name: '이든', outcome: 'working', still: true, looked: expect.stringContaining('https://miro.com/changelog/') })
  expect(prompt).toContain('lead with the answer itself')
})

test('rule 7\'s "still looking" is the writer\'s only while a part is at work; a rule-12 word is refused whatever the data holds', () => {
  const found = member({ id: 'm1', role: '소율', brief: '이번 주 미로 업데이트 조사', data: { facts: [fact('미로 Agents가 보드를 요약해 줘요.', 'https://miro.com/changelog/agents')] } })
  const json = (message: string) => JSON.stringify({ message, kept: ['f1'] })
  const link = '[미로](https://miro.com/changelog/agents)'
  // Nothing is at work: a message that still says it is being looked into is refused.
  expect(reportCheck(json(`소율이 보니 미로 Agents가 보드를 요약해 줘요. ${link}\n나머지는 아직 찾는 중이에요.`), [found])).toEqual({ refused: 'still' })
  // c13a r2: rule 12 has no exemption: the data holding "Agents" does not let 에이전트 through; the name kept as written passes.
  expect(reportCheck(json(`소율이 보니 미로 에이전트가 보드를 요약해 줘요. ${link}`), [found])).toEqual({ refused: 'jargon' })
  expect(reportCheck(json(`소율이 보니 미로 Agents가 보드를 요약해 줘요. ${link}`), [found])).toHaveProperty('text')
  // The cause: the writer is told to keep a name as the data writes it, and its own example holds none of the words.
  const prompt = reportPrompt('미로 이번 주 업데이트', [found])
  expect(prompt).toContain('stays exactly as the data writes it')
  expect(prompt.split('Data: ')[0]).not.toMatch(/에이전트|세션|토큰|프롬프트|런타임|컨텍스트/)
  expect(reportCheck(json(`소율이 보니 미로가 보드를 요약해 줘요. 세션도 길어졌어요. ${link}`), [found])).toEqual({ refused: 'jargon' })
})

test('each part has one outcome, from its state and data', () => {
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', state: 'working' }))).toBe('working')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', data: { facts: [], nothing: {} } }))).toBe('nothing-in-period')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', data: { facts: [fact('a', 'https://a.example')] } }))).toBe('found')
  // A teammate that hands back data and ended with none is not finished, whatever prose it left.
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', result: '보고 있었는데' }))).toBe('unfinished')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', state: 'released', result: 'Failed: it was stopped.' }))).toBe('unfinished')
})

test('live status names a part still at work as working, and one the runner marked not finished as not finished, never "끝냈어요"', () => {
  const bots = [{ id: 'chief', name: '엔그램', purpose: '', primary: true }, { id: 'bot-m1', name: '하람', purpose: '조사', label: '조사 담당' }, { id: 'bot-m2', name: '이든', purpose: '조사', label: '조사 담당' }] as never
  const task = (members: TeamMember[], state: DelegatedTask['state']): DelegatedTask => ({ id: 't', goal: 'g', botId: 'chief', state, turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
  const working = companyStatus(bots, [task([member({ id: 'm1', role: '하람', brief: '대전 공연 일정 찾기', title: '대전 공연 일정 찾기', data: { facts: [fact('a', 'https://a.example')] } }), member({ id: 'm2', role: '이든', brief: '부산 전시 일정 찾기', title: '부산 전시 일정 찾기', state: 'working' })], 'waiting')], WED.getTime())
  expect(working).toMatch(/이든은 부산 전시 일정 찾고 있/)
  const cut = companyStatus(bots, [task([member({ id: 'm1', role: '하람', brief: '대전 공연 일정 찾기', title: '대전 공연 일정 찾기', state: 'released', data: { facts: [fact('a', 'https://a.example')] } }), member({ id: 'm2', role: '이든', brief: '부산 전시 일정 찾기', title: '부산 전시 일정 찾기', state: 'released', unfinished: true })], 'done')], WED.getTime())
  expect(cut).toContain('이든은 부산 전시 일정 찾기를 다 못 끝냈어요.')
  expect(cut).not.toMatch(/이든[^.]*방금 끝냈|이든[^.]*끝낸 게 마지막/)
})

test('the record says a part that ended with nothing was not finished, and the summary never turns it, or a part at work, into "nothing new"; who left is data', async () => {
  const paths = await initVault(await tmpVaultRoot('c13a-record'))
  const haram = await createBot(paths, { name: '하람' }), eden = await createBot(paths, { name: '이든' })
  await employeeWriteBack(paths, { botId: haram.id, brief: '이번 주 피그마 업데이트 조사', result: '', title: '이번 주 피그마 업데이트 조사' }, WED)
  await employeeWriteBack(paths, { botId: eden.id, brief: '이번 주 캔바 업데이트 조사', result: '', title: '이번 주 캔바 업데이트 조사', data: { facts: [], nothing: {} } }, WED)
  expect((await teamRecord(paths)).facts.map(f => f.text)).toEqual(['이번 주 피그마 업데이트 조사 → 다 못 끝냈어요 (하람, 2026-11-18)', '이번 주 캔바 업데이트 조사 → 새로 나온 게 없었어요 (이든, 2026-11-18)'])
  // 이든 has since left the team; 소율 is at work on a part right now.
  const soyul = { id: 'bot-s', name: '소율', purpose: '조사', label: '조사 담당' }
  const live: DelegatedTask = { id: 't', goal: 'g', botId: 'chief', state: 'waiting', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members: [member({ id: 's', role: '소율', brief: '이번 주 미로 업데이트 조사', title: '이번 주 미로 업데이트 조사', botId: 'bot-s', state: 'working' })], hires: 1, maxHires: 8, maxDepth: 3, big: false } }
  const bots = [{ id: 'chief', name: '엔그램', purpose: '', primary: true }, { ...haram, label: '조사 담당' }, soyul] as never
  const asked: string[] = []
  // A writer that says the unfinished part found nothing new is refused; the host's own summary stands.
  const said = await teamSummary(paths, { bots, tasks: [live], message: '이번 주 팀 뭐 했는지 알려줘', now: WED, write: async prompt => { asked.push(prompt); return '이번 주엔 하람이 본 피그마 쪽은 새 소식이 없었어요. 이든이 본 캔바도 없었고 소율은 미로를 보고 있어요.' } })
  const record = JSON.parse(asked[0]!.split('Record: ')[1]!) as Record<string, unknown>[]
  expect(record.find(job => job['who'] === '하람')).toMatchObject({ unfinished: true, nothing: false })
  expect(record.find(job => job['who'] === '이든')).toMatchObject({ nothing: true, left: true })
  expect(record.find(job => job['who'] === '소율')).toMatchObject({ working: true, nothing: false })
  expect(said).not.toMatch(/하람[^.]*없었/)
  expect(said).toMatch(/하람은 피그마 업데이트 조사를 다 못 끝냈어요\./)
  expect(said).toMatch(/소율은 미로 업데이트 조사를 하고 있어요\./)
})

test('a listing page ("부산 전시 일정 모음") is judged by meaning and never counted as an item', async () => {
  const brief = '다음 달 부산 전시 일정 정리'
  const facts = [fact('12월 5일 벡스코에서 사진전이 열려요.', 'https://bexco.example/photo'), fact('부산 전시 일정 모음 페이지에 다음 달 전시가 여럿 올라와 있어요.', 'https://art.example/busan/list'), fact('12월 12일 해운대에서 미디어아트전이 열려요.', 'https://art.example/media')]
  const checked = await kindChecked({ facts }, brief, async () => '{"keep":[1,2,3],"lists":[2],"names":{"1":"벡스코 사진전","2":"부산 전시 모음","3":"미디어아트전"}}')
  expect(checked!.facts.map(f => !!f.listing)).toEqual([false, true, false])
  const text = mergedReport([member({ id: 'm1', role: '하람', brief, data: checked! })])
  expect(text.split('\n').filter(line => line.startsWith('- ') && !line.includes('여러 건이 한 페이지에'))).toHaveLength(2)
  expect(text).toContain('여러 건이 한 페이지에 모여 있어요.')
  expect(text).not.toMatch(/[23]개/)
})

test('the period searched matches the period asked, by date arithmetic, and the host\'s own date line is no period', () => {
  // "이번 주" on a Wednesday began on Monday: the week button, which reaches back to before Monday.
  const week = periodSpans('이번 주 피그마 업데이트', WED).find(span => span.name === '이번 주')!
  expect(periodSince(week.from, WED)).toBe('week')
  // "이번 주말" on its Saturday: the reach starts a day early, so Friday's forecast is inside it.
  const weekend = periodSpans('이번 주말 대전 공연', SAT).find(span => span.name === '이번 주말')!
  expect(periodSince(weekend.from, SAT)).toBe('week')
  // "이번 달" on the 18th: a month.
  expect(periodSince(periodSpans('이번 달 캔바 소식', WED)[0]!.from, WED)).toBe('month')
  // A teammate's task opens with the host's "Today is …" line: read as the person's word it was "today" (one day). Taken out, it is not.
  const task = `${dateLine('이번 주 미로 업데이트 조사', WED)}\nYour part:\n이번 주 미로 업데이트 조사`
  expect(newsPeriod(task)).toBe('day')
  expect(newsPeriod(task.replace(HOST_TODAY, ' '))).toBe('week')
  // c13a r2: a fact's date is its own day, so no lead where dates are checked: the weekend show (its own day Saturday) is a find, a
  // Friday item is not, and on a Wednesday last Sunday's launch is not this week's; a coming Friday (no year written) is this week's.
  const sat = fact('대전 야외 공연은 비 소식에 실내로 옮겨요.', 'https://news.example/1', '11월 21일'), fri = fact('대전 공연 할인 행사가 끝났어요.', 'https://news.example/2', '11월 20일')
  expect(inAskedPeriod({ facts: [sat, fri] }, '이번 주말 대전 공연 일정', SAT)).toEqual({ facts: [sat] })
  const sun = fact('캔바가 새 영상 편집기를 냈어요.', 'https://www.canva.com/newsroom/9', '11월 15일'), mon = fact('캔바 표 기능이 나왔어요.', 'https://www.canva.com/newsroom/10', '11월 16일'), coming = fact('캔바 행사가 금요일에 열려요.', 'https://www.canva.com/newsroom/11', '11월 20일')
  expect(inAskedPeriod({ facts: [sun, mon, coming] }, '이번 주 캔바 소식', WED)).toEqual({ facts: [mon, coming] })
  expect(inAskedPeriod({ facts: [sun] }, '이번 주 캔바 소식', WED)).toEqual({ facts: [], nothing: { latest: sun } })
  // c13a r3: the period ends too: next Monday's item (no year written, or with one) is not this week's, and alone it is no "latest".
  const nextMon = fact('캔바 새 요금제가 나와요.', 'https://www.canva.com/newsroom/12', '11월 23일'), nextYear = fact('캔바 연례 행사 일정이 나왔어요.', 'https://www.canva.com/newsroom/13', '2026년 11월 23일')
  expect(inAskedPeriod({ facts: [mon, nextMon, nextYear] }, '이번 주 캔바 소식', WED)).toEqual({ facts: [mon] })
  expect(inAskedPeriod({ facts: [nextMon] }, '이번 주 캔바 소식', WED)).toEqual({ facts: [], nothing: {} })
  expect(inAskedPeriod({ facts: [sun, nextMon] }, '이번 주 캔바 소식', WED)).toEqual({ facts: [], nothing: { latest: sun } })
  // The weekend's Sunday is its last day and inside it; the Monday after is not.
  const sunShow = fact('대전 공연 마지막 회차예요.', 'https://news.example/3', '11월 22일'), monShow = fact('대전 공연 추가 회차가 열려요.', 'https://news.example/4', '11월 23일')
  expect(inAskedPeriod({ facts: [sat, sunShow, monShow] }, '이번 주말 대전 공연 일정', SAT)).toEqual({ facts: [sat, sunShow] })
})

test('stack-13 (c13a r3 #1): a part added by a steer after the deadline answer is owed in the report after it, with the late ones', async () => {
  const { employeesReport, lateShown, lateOwed, markLate, plainSteer, steerSplit } = await import('../src/company-tools.js')
  const brief = (thing: string) => `이번 주 ${thing} 업데이트 조사`
  const team = { hires: 2, maxHires: 8, maxDepth: 2, big: false, members: [
    member({ id: 'm1', role: '하람', brief: brief('피그마'), topic: '피그마', data: { facts: [fact('피그마에 슬라이드 자동 정렬이 생겼어요.', 'https://www.figma.com/release-notes/1', '11월 17일')] } }),
    member({ id: 'm2', role: '이든', brief: brief('캔바'), topic: '캔바', state: 'working' }),
  ] }
  const job = { id: 't9', goal: '피그마, 캔바 이번 주 업데이트 알아봐줘', botId: 'lead', state: 'waiting', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team } as DelegatedTask
  // At the deadline 이든 is still at work: labeled in the answer made then.
  expect(markLate(job)).toEqual(['m2'])
  lateShown(job)
  // Then "미로도 넣어줘" while 이든 still works.
  const steer = plainSteer('미로도 넣어줘', [job], 'lead')!
  expect(steerSplit(job, steer, at)?.ids).toEqual(['m3'])
  const added = job.team!.members[2]!
  expect(added.late).toBe(true)
  // Both end: the report after holds the late part and the added one; nothing is owed after it.
  Object.assign(job.team!.members[1]!, { state: 'done', data: { facts: [fact('캔바가 표로 차트를 만드는 기능을 냈어요.', 'https://www.canva.com/newsroom/1', '11월 18일')] } })
  Object.assign(added, { state: 'done', data: { facts: [fact('미로에 회의 요약이 생겼어요.', 'https://miro.com/changelog/1', '11월 17일')] } })
  const after = employeesReport(job)!
  expect(after).toContain('https://www.canva.com/newsroom/1')
  expect(after).toContain('https://miro.com/changelog/1')
  expect(after).not.toContain('https://www.figma.com/release-notes/1')
  lateShown(job)
  expect(lateOwed(job)).toBe(false)
})
