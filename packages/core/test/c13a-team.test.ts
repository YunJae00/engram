import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { HOST_TODAY } from '../src/comet-navigation-tools.js'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import * as company from '../src/company-tools.js'
import { companyNote, companyStatus, employeeWriteBack, handBacks, partOutcome, teamRecord } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { newsPeriod, periodSince } from '../src/search-template.js'
import { dateLine, periodSpans } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const WED = new Date(2026, 10, 18, 10, 0)
const SAT = new Date(2026, 10, 21, 15, 0)
const at = new Date(WED.getTime() - 5_000).toISOString()
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'done', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
const fact = (text: string, url: string, date?: string) => ({ text, url, site: new URL(url).host, ...(date ? { date } : {}) })
interface Back { reports: Record<string, unknown>[]; note: string }
const back = (text: string | undefined): Back => JSON.parse(text!) as Back

test('no process sentence → k1: the lead is handed each of two parts with who did it, its name and its words, no count and no ready-made lead line, and is told to write one lead-in and no sections', () => {
  const ferry = member({ id: 'm1', role: '하람', brief: '이번 주 여수 여객선 시간표 변경 조사', topic: '여수', result: '여수 거문도행 첫 배가 11월 17일부터 7시 40분으로 당겨졌어요. https://ferry.example.kr/yeosu/notice/1\n막배는 그대로 16시예요. https://ferry.example.kr/yeosu/notice/2' })
  const pier = member({ id: 'm2', role: '이든', brief: '이번 주 통영 여객선 시간표 변경 조사', topic: '통영', result: '통영 욕지도행은 11월 18일부터 하루 한 편 늘었어요. https://ferry.example.kr/tongyeong/1' })
  for (const parts of [[ferry, pier], [{ ...ferry, topic: undefined }, { ...pier, topic: undefined }]]) {
    const out = back(handBacks(parts))
    expect(out.reports.map(r => [r['who'], r['result']])).toEqual([['하람', ferry.result], ['이든', pier.result]])
    for (const r of out.reports) expect(Object.keys(r).filter(key => !['who', 'part', 'state', 'result'].includes(key))).toEqual([])
    expect(Object.keys(out).sort()).toEqual(['note', 'reports'])
  }
  const { note } = back(handBacks([ferry, pier]))
  expect(note).toContain('one short lead-in line, then who did what in natural sentences that name each agent (never a line that starts with a name and a colon)')
  expect(note).toContain('No sections per agent')
})

test('the lead is given who did each part and where it stands as data: a finished part with its words, a part at work as working with none', () => {
  const done = member({ id: 'm1', role: '하람', brief: '이번 주 여수 여객선 시간표 변경 3개 조사', topic: '여수', result: '거문도행 첫 배가 7시 40분으로 당겨졌어요. https://ferry.example.kr/yeosu/notice/1', review: { ok: true, note: 'auto: employee report' } })
  const still = member({ id: 'm2', role: '이든', brief: '이번 주 통영 여객선 시간표 변경 조사', topic: '통영', state: 'working', sources: ['https://ferry.example.kr/tongyeong/'] })
  const lost = member({ id: 'm3', role: '소율', brief: '이번 주 목포 여객선 시간표 변경 조사', topic: '목포', state: 'failed', result: 'Failed: it ended without an answer.', review: { ok: false, note: 'auto: employee report' } })
  const out = back(handBacks([done, still, lost]))
  expect(out.reports[0]).toEqual({ who: '하람', part: '여수', state: 'done', result: done.result })
  expect(out.reports[1]).toEqual({ who: '이든', part: '통영', state: 'working', result: '', sources: ['https://ferry.example.kr/tongyeong/'] })
  expect(out.reports[2]).toMatchObject({ who: '소율', state: 'failed' })
  expect(out.note).toContain('Say plainly which part failed or is missing.')
})

test('rule 7\'s "still looking" and the rule-12 words are the writer\'s rules now: no check refuses a written answer, and the voice rule names every word', () => {
  expect(Object.entries(company).filter(([name, value]) => typeof value === 'function' && /report|answer|check|merge|written|kind|period/i.test(name)).map(([name]) => name).sort()).toEqual(['employeesAnswer'])
  expect(COLLEAGUE_CORE_RULE).toContain('Do not call yourself or anyone on the team an 에이전트, and never speak of 세션, 턴, 토큰, 프롬프트, 런타임 or 컨텍스트')
  expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
  expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it, so write it finished: nobody tidies, checks or completes it after you.')
  const words = '소율이 본 목포 쪽은 에이전트 예약 창구가 새로 생겼대요. https://ferry.example.kr/mokpo/agent'
  expect(back(handBacks([member({ id: 'm1', role: '소율', brief: '이번 주 목포 여객선 소식 조사', result: words })])).reports[0]!['result']).toBe(words)
})

test('each part has one outcome, from its state and words', () => {
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', state: 'working' }))).toBe('working')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', state: 'hired', result: '어제 본 것' }))).toBe('working')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', data: { facts: [], nothing: {} } }))).toBe('nothing-in-period')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', data: { facts: [fact('a', 'https://a.example')] } }))).toBe('found')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', result: '첫 배는 7시 40분이에요.' }))).toBe('found')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x', result: '보고 있었는데', unfinished: true }))).toBe('unfinished')
  expect(partOutcome(member({ id: 'a', role: '하람', brief: 'x' }))).toBe('unfinished')
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

test('the record says a part that ended with nothing was not finished, and the note and live status the team lane answers from never turn it, or a part at work, into "nothing new"; who left is off the team', async () => {
  const paths = await initVault(await tmpVaultRoot('c13a-record'))
  const haram = await createBot(paths, { name: '하람' }), eden = await createBot(paths, { name: '이든' })
  await employeeWriteBack(paths, { botId: haram.id, brief: '이번 주 피그마 업데이트 조사', result: '', title: '이번 주 피그마 업데이트 조사' }, WED)
  await employeeWriteBack(paths, { botId: eden.id, brief: '이번 주 캔바 업데이트 조사', result: '', title: '이번 주 캔바 업데이트 조사', data: { facts: [], nothing: {} } }, WED)
  expect((await teamRecord(paths)).facts.map(f => f.text)).toEqual(['이번 주 피그마 업데이트 조사 → 다 못 끝냈어요 (하람, 2026-11-18)', '이번 주 캔바 업데이트 조사 → 새로 나온 게 없었어요 (이든, 2026-11-18)'])
  const soyul = { id: 'bot-s', name: '소율', purpose: '조사', label: '조사 담당' }
  const live: DelegatedTask = { id: 't', goal: 'g', botId: 'chief', state: 'waiting', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members: [member({ id: 's', role: '소율', brief: '이번 주 미로 업데이트 조사', title: '이번 주 미로 업데이트 조사', botId: 'bot-s', state: 'working' })], hires: 1, maxHires: 8, maxDepth: 3, big: false } }
  const bots = [{ id: 'chief', name: '엔그램', purpose: '', primary: true }, { ...haram, label: '조사 담당' }, soyul] as never
  const note = await companyNote(paths, { bots, tasks: [live], message: '요번 주 팀원들 뭐 했는지 말해 줘', chief: true, now: WED })
  const [team, record] = note.split('The team\'s record') as [string, string]
  expect(record).toContain('이번 주 피그마 업데이트 조사 → 다 못 끝냈어요 (하람, 11월 18일)')
  expect(record).toContain('이번 주 캔바 업데이트 조사 → 새로 나온 게 없었어요 (이든, 11월 18일)')
  expect(record).not.toMatch(/하람[^\n]*없었/)
  expect(team).toContain('- 소율 — 조사 담당')
  expect(team).not.toContain('이든')
  const live_ = companyStatus(bots, [live], WED.getTime())
  expect(live_).toMatch(/소율은 [^.]*미로 업데이트 조사/)
  expect(live_).not.toMatch(/소율[^.]*없었/)
})

test('a listing page ("부산 전시 일정 모음") is never counted as an item in the team record', async () => {
  const paths = await initVault(await tmpVaultRoot('c13a-listing'))
  const haram = await createBot(paths, { name: '하람' })
  const brief = '다음 달 부산 전시 일정 정리'
  const facts = [{ ...fact('12월 5일 벡스코에서 사진전이 열려요.', 'https://bexco.example/photo'), name: '벡스코 사진전' }, { ...fact('부산 전시 일정 모음 페이지에 다음 달 전시가 여럿 올라와 있어요.', 'https://art.example/busan/list'), listing: true as const }, fact('12월 12일 해운대에서 미디어아트전이 열려요.', 'https://art.example/media')]
  await employeeWriteBack(paths, { botId: haram.id, brief, result: facts.map(f => `${f.text} ${f.url}`).join('\n'), title: brief, data: { facts } }, WED)
  expect((await teamRecord(paths)).facts.map(f => f.text)).toEqual([`${brief} → 벡스코 사진전 등 2개 찾았어요 (하람, 2026-11-18)`])
})

test('the period searched matches the period asked, by date arithmetic, and the host\'s own date line is no period', () => {
  const week = periodSpans('이번 주 피그마 업데이트', WED).find(span => span.name === '이번 주')!
  expect(periodSince(week.from, WED)).toBe('week')
  const weekend = periodSpans('이번 주말 대전 공연', SAT).find(span => span.name === '이번 주말')!
  expect(periodSince(weekend.from, SAT)).toBe('week')
  expect(periodSince(periodSpans('이번 달 캔바 소식', WED)[0]!.from, WED)).toBe('month')
  const task = `${dateLine('이번 주 미로 업데이트 조사', WED)}\nYour part:\n이번 주 미로 업데이트 조사`
  expect(newsPeriod(task)).toBe('day')
  expect(newsPeriod(task.replace(HOST_TODAY, ' '))).toBe('week')
  const day = (span: { from: Date; to: Date }, d: Date): boolean => d >= span.from && d <= span.to
  expect([new Date(2026, 10, 20), new Date(2026, 10, 21), new Date(2026, 10, 22), new Date(2026, 10, 23)].map(d => day(weekend, d))).toEqual([false, true, true, false])
  expect([new Date(2026, 10, 15), new Date(2026, 10, 16), new Date(2026, 10, 20), new Date(2026, 10, 23)].map(d => day(week, d))).toEqual([false, true, true, false])
  expect(dateLine('이번 주말 대전 공연 일정', SAT)).toContain('이번 주말')
})

test('stack-13 (c13a r3 #1): a part added by a steer after the deadline answer is owed in the hand-back after it, with the late ones', async () => {
  const { employeesAnswer, lateShown, lateOwed, markLate, plainSteer, steerSplit } = await import('../src/company-tools.js')
  const brief = (thing: string) => `이번 주 ${thing} 업데이트 조사`
  const team = { hires: 2, maxHires: 8, maxDepth: 2, big: false, members: [
    member({ id: 'm1', role: '하람', brief: brief('피그마'), topic: '피그마', result: '피그마에 슬라이드 자동 정렬이 생겼어요. https://www.figma.com/release-notes/1' }),
    member({ id: 'm2', role: '이든', brief: brief('캔바'), topic: '캔바', state: 'working' }),
  ] }
  const job = { id: 't9', goal: '피그마, 캔바 이번 주 업데이트 알아봐줘', botId: 'lead', state: 'waiting', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team } as DelegatedTask
  expect(markLate(job)).toEqual(['m2'])
  lateShown(job)
  const steer = plainSteer('미로도 넣어줘', [job], 'lead')!
  expect(steerSplit(job, steer, at)?.ids).toEqual(['m3'])
  const added = job.team!.members[2]!
  expect(added.late).toBe(true)
  Object.assign(job.team!.members[1]!, { state: 'done', result: '캔바가 표로 차트를 만드는 기능을 냈어요. https://www.canva.com/newsroom/1' })
  Object.assign(added, { state: 'done', result: '미로에 회의 요약이 생겼어요. https://miro.com/changelog/1' })
  const after = employeesAnswer(job)!
  expect(back(after).reports.map(r => r['who'])).toEqual(['이든', added.role])
  expect(after).toContain('https://www.canva.com/newsroom/1')
  expect(after).toContain('https://miro.com/changelog/1')
  expect(after).not.toContain('https://www.figma.com/release-notes/1')
  lateShown(job)
  expect(lateOwed(job)).toBe(false)
})
