import { expect, test, vi } from 'vitest'
import { mergedReport, reportData, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'

// stack-8 section 3: the stored results of stack7-b3ddda26 (tasks.json), fed through the host's merge. Each teammate came back with their
// own sentence and a link, and the thread read three "… 쪽은 이번엔 못 찾았어요." lines under "셋 다 찾아봤어요." (C3).
const member = (id: string, role: string, brief: string, result: string, topic?: string): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, ...(topic ? { topic } : {}), lookup: true, state: 'released', sessionKey: `s-${id}`, hiredAt: '2026-11-17T04:21:10.414Z', result, review: { ok: true, note: 'auto' } }) as TeamMember
// c11a: what each teammate handed back, as their fenced report block, read once (reportData) the way settleMember stores it.
const withData = (m: TeamMember, report: object): TeamMember => ({ ...m, data: reportData('```report\n' + JSON.stringify(report) + '\n```', m)! })
const latest = (text: string, url: string, date?: string): object => ({ nothing_in_period: { latest: { text, url, ...(date ? { date } : {}) } } })
// Each part's block: its head names the teammate.
const blocks = (out: string): string[] => out.split('\n\n')

test('C3: a teammate who found nothing new this week keeps their own sentence and link, and the lead says nothing is new (c11a: structure)', () => {
  const out = mergedReport([
    withData(member('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', '', '노션'), latest('캘린더·일정 관리 신기능(AI·캘린더 업데이트)', 'https://blog.naver.com/airang_checkin/224398073903', '1월 20일')),
    withData(member('m2', '서연', '이번 주 슬랙 신기능 조사해서 알려줘', '', '슬랙'), latest("챗GPT의 '라이팅 스타일' 기능 소식(슬랙 자체 신기능은 아님)", 'https://www.wikitree.co.kr/articles/1157905', '11월 16일')),
    withData(member('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', '', '리니어'), latest('리니어 대안/경쟁사 비교 글', 'https://clickup.com/ko/blog/67806/linear-alternatives')),
  ])
  expect(out).not.toMatch(/찾아봤어요|못 찾았어요|출처/)
  // c15b (cause F): one block; the nothing-new all three share is said once, then each part's row names its teammate, its latest and link.
  expect(blocks(out)).toHaveLength(1)
  const [head, ...parts] = out.split('\n')
  expect(head).toMatch(/새로 나온 게 없/)
  expect(out.match(/새로 나온 게 없/g)).toHaveLength(1)
  for (const [i, [name, words]] of ([['지민', '1월 20일'], ['서연', '라이팅 스타일'], ['도윤', '경쟁사 비교 글']] as const).entries()) {
    expect(parts[i]).toContain(`(${name})`)
    expect(parts[i]).toContain(words)
    expect(parts[i]).toMatch(/\]\(https:\/\//)
  }
  expect(out.match(/\]\(https:\/\//g)).toHaveLength(3)
})

test('R2: price and date lines keep no empty "(출처: )", no "… — 출처" tail and no "결과를 보고드려요" opener; three links on three hosts (c11a: structure)', () => {
  const out = mergedReport([
    withData(member('m1', '아이폰18', '아이폰 18의 가격과 출시일을 조사해줘.', ''), { facts: [
      { text: '가격: 아이폰18 프로 256GB 기준 199만원', url: 'https://blog.naver.com/cnpabc123/224479926970', site: '출처' },
      { text: '출시일: 아이폰18 프로는 이미 출시됨, 일반형은 2027년 봄 예상', url: 'https://www.youtube.com/watch?v=s3wLAIMQpPs' }] }),
    withData(member('m2', '갤럭시S27', '갤럭시 S27의 가격과 출시일을 조사해줘.', ''), { facts: [
      { text: '가격: 미발표, 전작 S26 1,045,000원', url: 'https://smartstore.naver.com/main/products/13734664121' },
      { text: '출시일: 미발표, 2027년 1~2월 공개설', url: 'https://blog.naver.com/yongyongvvv/224479063208', site: '출처' }] }),
    withData(member('m3', '픽셀11', '픽셀 11의 가격과 출시일을 조사해줘.', ''), { facts: [
      { text: '가격: 출시 당시 가격 체계가 전작보다 인상됨', url: 'https://yellow.com/ko/news/pixel-11', site: 'Yellow' },
      { text: '출시일: 2026년 8월 20일 정식 출시', url: 'https://yellow.com/ko/news/pixel-11' }] }),
  ])
  expect(out).not.toMatch(/\(출처[:：]?\s*(출처\s*)?\)|— 출처|보고드려요|[一-鿿぀-ヿ]/u)
  // No link is named 출처, even where the teammate gave that word as the site.
  expect(out).not.toMatch(/\[출처\]/)
  // c12a B1: these members have no part name, so each is led by its teammate in a sentence, not "(name)".
  for (const name of ['아이폰18', '갤럭시S27', '픽셀11']) expect(out).toContain(name)
  expect(out).not.toMatch(/(?<!\]\()https?:\/\//)
  const hosts = [...out.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(found => new URL(found[1]!).host.replace(/^(?:www|blog|smartstore)\./, ''))
  expect(new Set(hosts).size).toBe(3)
})

test('C3 (c8b run): when every teammate says first that nothing new was found, the lead says so and a writer\'s claim of news is not shown (c11a: structure)', async () => {
  const members = [
    withData(member('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', '', '노션'), latest('AI 에이전트 개편(크레딧 체계 개편, Auto 모델 라우터)', 'https://www.notion.com/releases/2026-10-19', '10월 19일')),
    withData(member('m2', '서연', '이번 주 슬랙 신기능 조사해서 알려줘', '', '슬랙'), latest('Android용 슬랙 릴리스 노트의 버그 수정', 'https://slack.com/intl/ko-kr/release-notes/android')),
    withData(member('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', '', '리니어'), { nothing_in_period: {} }),
  ]
  const write = vi.fn(async () => '리니어만 새 소식이 있어요.')
  const out = await writtenReport({ ask: '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', members, write, now: new Date('2026-11-17T05:29:19.705Z') })
  // The writer's message is not JSON and fails the host's check: the host's rendering of the data stands.
  expect(out).toBe(mergedReport(members))
  expect(out).not.toContain('새 소식이 있어요')
  expect(blocks(out).every(part => /새로 나온 게 없/.test(part))).toBe(true)
  expect(out).toContain('10월 19일')
  expect(out).toContain('버그 수정')
})

test('C5 (c8b run): an item that ends on its link\'s own name does not say the name twice', () => {
  const out = mergedReport([withData(member('m1', '지민', '다음 달 서울 IT 행사 일정 정리', ''), { facts: [
    { text: '소프트웨이브 2026(제11회 대한민국 소프트웨어 대전), 코엑스', url: 'https://www.coex.co.kr/event/1', date: '12월 2일~4일' },
    { text: 'AI 서밋 서울, 양재 aT센터', url: 'https://aisummit.co.kr/2026', date: '12월 9일' }] })])
  expect(out.match(/\]\(https:\/\//g)).toHaveLength(2)
  expect(out).not.toMatch(/코엑스 \[코엑스\]|코엑스 코엑스/)
})
