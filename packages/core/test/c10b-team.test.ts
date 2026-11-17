import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { checkedReport, mergedReport, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'

// c10b: the named team's thread of the stack-9 run (runs/stack9-b685945e, tasks.json), read on its own day.
const run = JSON.parse(readFileSync(new URL('./fixtures/c10b-stack9-team.json', import.meta.url), 'utf8')) as Record<'it' | 'notion' | 'slack' | 'linear', { brief: string; result: string; sources: string[] }>
const NOV17 = new Date(2026, 10, 17, 12)
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })
const ENGLISH_RUN = /(?:[A-Za-z][A-Za-z'’-]*[\s,]+){3,}[A-Za-z][A-Za-z'’-]*/

test('c10b fix 1: the list job keeps only IT events: the jazz concert goes, 소프트웨이브 stays, and the lead says one', () => {
  // The run's own pieces: the answer it had written, then the rows it read when its time ran out.
  const [answer, ...rows] = run.it.result.replace(/\n\(시간 한도에서 멈춤[^)]*\)$/, '').split('\n')
  const jimin = member({ brief: run.it.brief, voice: '차분하고 또박또박' })
  settleMember(jimin, { answer: answer!, read: rows.join('\n'), timedOut: true, sources: run.it.sources }, '2026-11-17T08:46:36Z', true)
  expect(jimin.result).not.toMatch(/카즈미|내한공연/)
  expect(jimin.result).toContain('소프트웨이브 2026')
  // What the person read: the writer's list with the concert in it. The host takes it out and the lead counts what is left.
  const coex = answer!.match(/https:\/\/\S+/)![0]
  const sujb = rows.join('\n').match(/https:\/\/sujb\.kr\S+/)![0]
  const raw = `지민: 12월 2~4일 코엑스에서 소프트웨이브 2026이 제일 커요.\n\n- 12월 2~4일, 소프트웨이브 2026(제11회 대한민국 소프트웨어 대전) - AI·SW·클라우드·보안 분야 비즈니스 전시회 [출처](${coex})\n- 12월 24일, 2026 카즈미 타테이시 트리오 내한공연 - 강동아트센터 대극장 [출처](${sujb})`
  const shown = checkedReport(raw, [jimin], { ask: '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', now: NOV17 })!
  expect(shown).toBeDefined()
  expect(shown).not.toMatch(/카즈미|공연/)
  expect(shown).toContain('소프트웨이브 2026')
  expect(shown.split('\n')[0]).toBe('지민: 12월 서울 IT 행사는 확실한 건 하나예요.')
  // A list item that stands only on a search page goes while another has a real page; the last item is never dropped.
  const listed = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(listed, { answer: '12월 2일 소프트웨이브 https://www.coex.co.kr/a\n12월 9일 데브 밋업 https://search.naver.com/search.naver?query=x' }, 'now', true)
  expect(listed.result).toBe('12월 2일 소프트웨이브 https://www.coex.co.kr/a')
  const alone = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(alone, { answer: '12월 24일 재즈 공연 https://example.com/a' }, 'now', true)
  expect(alone.result).toBe('12월 24일 재즈 공연 https://example.com/a')
  // A job that is no list is never touched.
  const one = member({ brief: '이번 주말 서울 공연 찾아줘' })
  settleMember(one, { answer: '12월 24일 재즈 공연이 있어요. https://example.com/a' }, 'now', true)
  expect(one.result).toContain('재즈 공연')
})

const c3 = (): TeamMember[] => [
  member({ id: 'a', role: '지민', topic: '노션', brief: run.notion.brief, result: run.notion.result, sources: run.notion.sources }),
  member({ id: 'b', role: '서연', topic: '슬랙', brief: run.slack.brief, result: run.slack.result, sources: run.slack.sources, botId: 'b2' }),
  member({ id: 'c', role: '도윤', topic: '리니어', brief: run.linear.brief, result: run.linear.result, sources: run.linear.sources, botId: 'b3' }),
]
const ASK = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'

test('c10b fix 2 and 3: nothing new this week is said, each line gives its latest day, and no English debris is left', async () => {
  const said = mergedReport(c3(), undefined, [], { ask: ASK, now: NOV17 }), [lead, ...lines] = said.split('\n\n')
  expect(lead).toBe('이번 주엔 셋 다 새로 낸 게 없어요. 가장 최근 것만 적었어요.')
  expect(lines.map(line => line.split(': ')[0])).toEqual(['지민', '서연', '도윤'])
  expect(lines[0]).toMatch(/^지민: 노션의 가장 최근 업데이트는 2026년 10월 19일에 나온/)
  expect(lines[1]).toMatch(/^서연: 슬랙은 이번 주\(11\/16~11\/22\)엔 새로 낸 게 없더라고요! 최근엔 2026년 11월 9일에 /)
  expect(lines[2]).toMatch(/^도윤: 리니어는 최근엔 11월 12일에 BYOK 기능이 나왔어요\. /)
  for (const line of lines) expect(line).toMatch(/\]\(https:\/\/[^)]+\)$/)
  expect(said).not.toMatch(/확인해 보니|\(등\)|\(BYOK\)'|\(\s*\)|셋 다 찾아봤어요/)
  expect(said.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(ENGLISH_RUN)
  // The second stored string, where the run showed "자체 API 키(등)를": a part asked with no period shows both sentences.
  const free = (m: TeamMember): TeamMember => ({ ...m, brief: m.brief.replace('이번 주 ', '') })
  const plain = mergedReport([free(c3()[0]!), free(c3()[2]!)], undefined, [], { ask: '노션이랑 리니어 신기능 조사해서 알려줘', now: NOV17 })
  expect(plain).toContain('11월 12일에 BYOK 기능이 나왔어요.')
  expect(plain).toContain('자체 API 키를 연결해서')
  expect(plain).not.toMatch(/\(등\)|\(BYOK\)'|\(\s*\)|확인해 보니/)
  expect(plain.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(ENGLISH_RUN)
  // No writer is asked to say it again: the host's honest answer stands.
  expect(await writtenReport({ ask: ASK, members: c3(), now: NOV17, timeoutMs: 500, write: async () => '셋 다 찾아봤어요.' })).toBe(said)
  // When another part found something this week, the old one's line says first that nothing is new for it.
  const [, , doyun] = c3()
  const fresh = member({ id: 'a', role: '지민', topic: '노션', brief: run.notion.brief, result: '노션은 11월 18일에 AI 회의록 기능을 냈어요. https://www.notion.com/ko/releases' })
  const mixed = mergedReport([fresh, doyun!], undefined, [], { ask: ASK, now: NOV17 }).split('\n\n')
  expect(mixed.at(-1)).toMatch(/^도윤: 리니어는 이번 주엔 새로 낸 게 없어요\. 최근엔 11월 12일에 BYOK 기능이 나왔어요\./)
})
