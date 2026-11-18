import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { checkedReport, mergedReport, reportData, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { keptItems, settleMember } from '../src/team-hire-tools.js'

// c10b: the named team's thread of the stack-9 run (runs/stack9-b685945e, tasks.json), read on its own day.
const run = JSON.parse(readFileSync(new URL('./fixtures/c10b-stack9-team.json', import.meta.url), 'utf8')) as Record<'it' | 'notion' | 'slack' | 'linear', { brief: string; result: string; sources: string[] }>
const NOV17 = new Date(2026, 10, 17, 12)
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })
const ENGLISH_RUN = /(?:[A-Za-z][A-Za-z'’-]*[\s,]+){3,}[A-Za-z][A-Za-z'’-]*/

// c11a: a teammate's answer as its fenced report block.
const block = (report: object): string => '```report\n' + JSON.stringify(report) + '\n```'
const withData = (m: TeamMember, report: object): TeamMember => ({ ...m, data: reportData(block(report), m, m.sources ?? [])! })
const SEARCH = 'https://search.naver.com/search.naver?query=x'
// Each part's block of the host's rendering, by the teammate it names.
const partOf = (said: string, name: string): string => said.split('\n\n').find(part => part.split('\n')[0]!.includes(`(${name}`))!

test('c10b fix 1: the list job keeps only IT events: the jazz concert goes, 소프트웨이브 stays, and the lead says one (c11a: structure: the writer leaves it out, the host checks the links)', () => {
  // The run's own pieces: the answer it had written, then the rows it read when its time ran out, now handed back as data.
  const [answer, ...rows] = run.it.result.replace(/\n\(시간 한도에서 멈춤[^)]*\)$/, '').split('\n')
  const coex = answer!.match(/https:\/\/\S+/)![0]
  const sujb = rows.join('\n').match(/https:\/\/sujb\.kr\S+/)![0]
  const jimin = member({ brief: run.it.brief, voice: '차분하고 또박또박' })
  const report = block({ facts: [{ text: '소프트웨이브 2026(제11회 대한민국 소프트웨어 대전), 코엑스', date: '12월 2~4일', url: coex }, { text: '2026 카즈미 타테이시 트리오 내한공연, 강동아트센터 대극장', date: '12월 24일', url: sujb }] })
  settleMember(jimin, { answer: report, read: rows.join('\n'), timedOut: true, sources: run.it.sources, report: reportData(report, jimin, run.it.sources) ?? null }, '2026-11-17T08:46:36Z', true)
  expect(jimin.data?.facts).toHaveLength(2)
  expect(jimin.result).toContain('소프트웨이브 2026')
  // The writer leaves the concert out by what it is (kept: f1 only); the host accepts it, with the link named by its site, never 출처.
  const message = (text: string, kept: string[]): string => JSON.stringify({ message: text, kept })
  const shown = checkedReport(message(`다음 달 서울 IT 행사는 지민이 찾아보니 12월 2~4일 코엑스에서 열리는 소프트웨이브 2026이 제일 커요. [출처](${coex})`, ['f1']), [jimin])!
  expect(shown).toBeDefined()
  expect(shown).not.toMatch(/카즈미|공연|\[출처\]/)
  expect(shown).toContain('소프트웨이브 2026')
  expect(shown).toContain(`(${coex})`)
  // A line led by the name and a colon, or a dropped fact still linked, is refused.
  expect(checkedReport(message(`지민: 12월 2~4일 코엑스에서 소프트웨이브 2026이 열려요. [코엑스](${coex})`, ['f1']), [jimin])).toBeUndefined()
  // A dropped fact never reaches the thread as a link.
  expect(checkedReport(message(`지민이 찾아보니 12월 2~4일 소프트웨이브 2026이 열려요. [코엑스](${coex}) 12월 24일엔 공연도 있어요. [공연](${sujb.replace(/\(/g, '%28').replace(/\)/g, '%29')})`, ['f1']), [jimin]) ?? '').not.toContain('](https://sujb.kr/')
  // A list item that stands only on a search page goes while another has a real page; the last item is never dropped for its link.
  const listed = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(listed, { answer: '12월 2일 소프트웨이브 https://www.coex.co.kr/a\n12월 9일 데브 밋업 https://search.naver.com/search.naver?query=x' }, 'now', true)
  expect(listed.result).toBe('12월 2일 소프트웨이브 https://www.coex.co.kr/a')
  // c11a: a teammate whose answer holds no report block is shown as having brought nothing; its prose (a concert) is never parsed into items.
  const alone = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(alone, { answer: '12월 24일 재즈 공연 https://example.com/a', report: reportData('12월 24일 재즈 공연 https://example.com/a', alone) ?? null }, 'now', true)
  expect(alone.data).toBeUndefined()
  const lone = mergedReport([{ ...alone, role: '지민' }])
  expect(lone).not.toMatch(/재즈|공연|확실한 건/)
  // c12a B1: no job-title head. c13a (cause H): no host sentence about the teammate; the line, then whose it is.
  expect(lone).toBe('이번엔 못 찾았어요 (지민).')
  const searched = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(searched, { answer: '12월 9일 데브 밋업 https://search.naver.com/search.naver?query=x' }, 'now', true)
  expect(searched.result).toContain('데브 밋업')
  // A job that is no list is never touched.
  const one = member({ brief: '이번 주말 서울 공연 찾아줘' })
  settleMember(one, { answer: '12월 24일 재즈 공연이 있어요. https://example.com/a' }, 'now', true)
  expect(one.result).toContain('재즈 공연')
})

const c3 = (): TeamMember[] => [
  withData(member({ id: 'a', role: '지민', topic: '노션', brief: run.notion.brief, result: run.notion.result, sources: run.notion.sources }), { nothing_in_period: { latest: { text: '"Agents, 효율은 높이고 비용은 낮추다" 업데이트가 나왔어요.', date: '2026년 10월 19일', url: 'https://www.notion.com/ko/releases' } } }),
  withData(member({ id: 'b', role: '서연', topic: '슬랙', brief: run.slack.brief, result: run.slack.result, sources: run.slack.sources, botId: 'b2' }), { nothing_in_period: { latest: { text: '맥용 4.53.287 버전이 나왔는데 보안 개선 위주예요.', date: '2026년 11월 9일', url: 'https://slack.com/intl/ko-kr/release-notes/mac' } } }),
  withData(member({ id: 'c', role: '도윤', topic: '리니어', brief: run.linear.brief, result: run.linear.result, sources: run.linear.sources, botId: 'b3' }), { nothing_in_period: { latest: { text: 'BYOK 기능이 나왔어요.', date: '11월 12일', url: 'https://linear.app/changelog' } } }),
]
const ASK = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'

test('c10b fix 2 and 3: nothing new this week is said, each line gives its latest day, and no English debris is left (c11a: structure)', async () => {
  // c15b (cause F): the verdict all three share leads once; then one row per part with its latest, its day and its own link.
  const said = mergedReport(c3()), [head, ...parts] = said.split('\n')
  expect(head).toMatch(/^셋 다 이번엔 새로 나온 게 없/)
  expect(said.match(/새로 나온 게 없/g)).toHaveLength(1)
  expect(parts.map(part => /\((\S+)\):/.exec(part)?.[1])).toEqual(['지민', '서연', '도윤'])
  for (const [i, day] of ['2026년 10월 19일', '2026년 11월 9일', '11월 12일'].entries()) {
    expect(parts[i]).toContain(day)
    expect(parts[i]).toMatch(/\]\(https:\/\/[^)]+\)$/)
  }
  expect(said).not.toMatch(/확인해 보니|\(등\)|\(BYOK\)'|\(\s*\)|셋 다 찾아봤어요|출처/)
  expect(said.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(ENGLISH_RUN)
  // A part asked with no period hands back what it found: its text is shown whole.
  const free = withData(member({ id: 'c', role: '도윤', topic: '리니어', brief: '리니어 신기능 조사해서 알려줘', sources: run.linear.sources }), { facts: [{ text: '11월 12일에 BYOK 기능이 나왔어요. 리니어 에이전트에 자체 API 키를 연결해서 쓸 수 있어요.', url: 'https://linear.app/changelog' }] })
  const plain = mergedReport([c3()[0]!, free])
  expect(plain).toContain('11월 12일에 BYOK 기능이 나왔어요.')
  expect(plain).toContain('자체 API 키를 연결해서')
  expect(plain).not.toMatch(/\(등\)|\(BYOK\)'|\(\s*\)|확인해 보니/)
  expect(plain.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(ENGLISH_RUN)
  // A writer's answer that fails the check is not shown: the host's honest answer stands.
  expect(await writtenReport({ ask: ASK, members: c3(), now: NOV17, timeoutMs: 500, write: async () => '셋 다 찾아봤어요.' })).toBe(said)
  // When another part found something this week, the old one's part still says first that nothing is new for it.
  const [, , doyun] = c3()
  const fresh = withData(member({ id: 'a', role: '지민', topic: '노션', brief: run.notion.brief }), { facts: [{ text: '노션은 11월 18일에 AI 회의록 기능을 냈어요.', url: 'https://www.notion.com/ko/releases' }] })
  const mixed = mergedReport([fresh, doyun!])
  // c12a B2: the day once, after a text that does not state it.
  expect(partOf(mixed, '도윤').replace(/^[^:]+:\s*/, '')).toMatch(/^이번엔 새로 나온 게 없[^]*BYOK 기능이 나왔어요 \(11월 12일\)\./)
  expect(partOf(mixed, '지민')).toContain('11월 18일')
})

test('c10b r1 (Codex): a lone teammate\'s list keeps its links and loses an English run with the colon that led to it (c11a: structure)', () => {
  const m = withData(member({ brief: '다음 달 서울 IT 행사 일정 정리' }), { facts: [{ text: '소프트웨이브, 클라우드 보안 발표', date: '12월 2일', url: 'https://www.coex.co.kr/a' }, { text: '데브 밋업', date: '12월 9일', url: 'https://www.meetup.com/b' }] })
  const said = mergedReport([m])
  expect(said.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(ENGLISH_RUN)
  // c12a B2: a text with no day of its own carries it once, after it.
  // c13a: whose the list is, once, on its first line.
  // c16a r2: updated (pinned the old "(name)" tag on a one-part line): whose it is is the first line's subject, "<name>이/가 찾아보니 …".
  expect(said).toMatch(/^- 지민이 찾아보니 소프트웨이브.* \(12월 2일\) \[[^\]]+\]\(https:\/\/www\.coex\.co\.kr\/a\)$/m)
  expect(said).toMatch(/^- 데브 밋업 \(12월 9일\) \[[^\]]+\]\(https:\/\/www\.meetup\.com\/b\)$/m)
  expect(said).not.toMatch(/:\s*·|""|\[출처\]/)
  // A writer's message with an English run is refused; the host's rendering stands.
  expect(checkedReport(JSON.stringify({ message: '지민이 찾아보니 12월 2일 소프트웨이브: software developers meet for cloud security talks [코엑스](https://www.coex.co.kr/a) 12월 9일 데브 밋업 [밋업](https://www.meetup.com/b)', kept: ['f1', 'f2'] }), [m])).toBeUndefined()
})

test('c10b r2 (Codex): an item that runs over several lines goes or stays whole (c11a: dropped for a search-page-only link, not by kind)', () => {
  const brief = '이번 달 부산 AI 모임 목록 만들어줘'
  // The show's venue line repeats its day, and the next show's address has no day at all: both go with their show.
  const text = `1) 12월 3일 부산 AI 해커톤\n   벡스코 제2전시장 https://bexco.example/hack\n2) 12월 10일 바이올린 리사이틀\n   영화의전당 12월 10일 저녁 ${SEARCH}\n12월 14일 오케스트라 공연\n   해운대 문화회관 ${SEARCH}\n- 12월 20일 클라우드 보안 밋업 https://meet.example/c`
  const kept = keptItems(brief, text)
  expect(kept).not.toMatch(/리사이틀|영화의전당|오케스트라|문화회관/)
  expect(kept).toBe('1) 12월 3일 부산 AI 해커톤\n   벡스코 제2전시장 https://bexco.example/hack\n- 12월 20일 클라우드 보안 밋업 https://meet.example/c')
  // Codex's own repro: the concert's second line no longer stands as a second event.
  expect(keptItems('다음 달 서울 IT 행사 일정 정리', `12월 2일 소프트웨이브 https://www.coex.co.kr/a\n12월 24일 재즈 공연\n강동아트센터 12월 24일 ${SEARCH}`)).toBe('12월 2일 소프트웨이브 https://www.coex.co.kr/a')
})

test('c10b r2 (Codex): a line for a part with nothing new in the time asked opens with that, whatever the teammate wrote first (c11a: structure)', () => {
  // c15b: when every part found nothing new, that verdict opens the message once, before every part's row.
  expect(mergedReport(c3()).split(/(?<=[.!?])\s+/)[0]).toMatch(/새로 나온 게 없/)
  // Another wording: the old find first, the verdict second. The verdict leads, and the old find keeps its day.
  const old = withData(member({ id: 'f', role: '하린', topic: '피그마', brief: '이번 주 피그마 새 기능 찾아줘' }), { note: '이번 주에는 발표가 없었어요.', nothing_in_period: { latest: { text: '자동 레이아웃 개선', date: '11월 3일', url: 'https://www.figma.com/release-notes' } } })
  const other = withData(member({ id: 'g', role: '태오', topic: '캔바', brief: '이번 주 캔바 새 기능 찾아줘' }), { facts: [{ text: '캔바는 11월 18일에 AI 사진 편집을 냈어요.', url: 'https://www.canva.com/newsroom' }] })
  const harin = partOf(mergedReport([old, other]), '하린')
  expect(harin).toMatch(/^피그마\(하린\): 이번엔 새로 나온 게 없/)
  expect(harin).toContain('11월 3일')
  expect(harin).toContain('(https://www.figma.com/release-notes)')
})

test('stack-10 (c10b r3 Codex #2): a field bullet under an item ("- 장소: …") goes or stays with it, and is no item of its own (c11a: dropped for a search-page-only link, not by kind)', () => {
  const brief = '다음 달 부산 AI 행사 목록 정리'
  const kept = keptItems(brief, `- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 장소: 벡스코 제2전시장\n- 12월 18일 겨울 클래식 콘서트\n- 장소: 부산문화회관 ${SEARCH}\n- 요금: 3만 원`)
  expect(kept).toBe('- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 장소: 벡스코 제2전시장')
  // Codex's own repro.
  expect(keptItems('다음 달 서울 IT 행사 일정 정리', `- 12월 2일 소프트웨이브 https://www.coex.co.kr/a\n- 12월 24일 재즈 공연\n- 장소: 강동아트센터 ${SEARCH}`)).toBe('- 12월 2일 소프트웨이브 https://www.coex.co.kr/a')
  // A bullet with its own day is its own item, label or not.
  expect(keptItems(brief, '- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 밋업: 12월 10일 클라우드 보안 밋업 https://sec.example/m')).toContain('클라우드 보안 밋업')
})
