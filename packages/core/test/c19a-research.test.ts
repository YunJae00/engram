import { expect, test } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { COLLEAGUE_CORE_RULE } from '../src/prompt.js'
import { employeesAnswer, handBacks } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { withoutRepeats } from '../src/search-template.js'
import { keepRead, keepSources, LOOKUP_MAX_CALLS, LOOKUP_ROUND_MS, LOOKUP_RULE, NO_LIVE_SOURCE, settleMember, timeBoxed, withLiveSources } from '../src/team-hire-tools.js'

interface Handed { added?: string[]; reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const handed = (members: readonly TeamMember[], added?: readonly string[]): Handed => JSON.parse(handBacks(members, added)) as Handed
const helper = (id: string, topic: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 알려줘`, lookup: true, state: 'working', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const settled = (id: string, topic: string, answer: string, sources: string[] = [], rest: Partial<TeamMember> = {}): TeamMember => { const one = helper(id, topic, rest); settleMember(one, { answer, sources }, 'now', true); return one }
const job = (members: TeamMember[]): DelegatedTask => ({ id: 't', goal: '', botId: 'lead', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
const page = (name: string): string => `https://${name}.example/info`
const searching = (out: string): AgentTool => ({ name: 'search_web', description: '', argsSchema: {}, run: async () => out })

test('1. four helpers each citing a page they were shown: four values and four links reach the lead in one hand-back, and nothing is judged on the way', () => {
  const topics = [['약수터', '입장은 무료예요.'], ['케이블카', '왕복 1만 5천 원이에요.'], ['여객선', '첫 배는 6시 40분이에요.'], ['도서관', '평일 9시에 열어요.']] as const
  const members = topics.map(([topic, said], i) => settled(`m${i + 1}`, topic, `${said} [${topic}](${page(`p${i}`)})`, [page(`p${i}`)]))
  const back = handed(members)
  expect(back.reports).toHaveLength(4)
  expect(back.reports.map(r => r.result)).toEqual(topics.map(([topic, said], i) => `${said} [${topic}](${page(`p${i}`)})`))
  expect(JSON.stringify(back.reports)).not.toContain('못 찾았어요')
})

test('2. a part added mid-work is in the hand-back with the others and is named in "added": nothing is dropped', () => {
  const first = settled('m1', '약수터', `입장은 무료예요. ${page('spring')}`, [page('spring')])
  const added = settled('m2', '둘레길', `2구간은 4월까지 막혀요. ${page('trail')}`, [page('trail')])
  const back = handed([first, added], ['둘레길도 넣을게요.'])
  expect(back.added).toEqual(['둘레길도 넣을게요.'])
  expect(back.reports.map(r => r.part)).toEqual(['약수터', '둘레길'])
  expect(back.note).toContain('Mention anyone in "added" in one short line')
})

test('3. one helper that handed back nothing is in the hand-back once, as failed, beside the others; the lead\'s "모두" is the lead\'s to write', () => {
  const none = helper('m2', '케이블카')
  settleMember(none, { answer: '' }, 'now', true)
  const back = handed([settled('m1', '약수터', `입장은 무료예요. ${page('spring')}`, [page('spring')]), none])
  expect(back.reports.map(r => [r.part, r.state])).toEqual([['약수터', 'done'], ['케이블카', 'failed']])
  expect(back.reports.filter(r => r.part === '케이블카')).toHaveLength(1)
  expect(back.note).toContain('Say plainly which part failed or is missing')
})

test('4. a link the helper was never shown stays in its sentence as the helper wrote it: the host takes no link out, and the rule to copy an address is the model\'s', () => {
  const said = `케이블카는 왕복 1만 5천 원이에요. [요금표](${page('unseen')})`
  const one = settled('m1', '케이블카', said, [page('seen')])
  expect(one.result).toBe(said)
  expect(one.sources).toEqual([page('seen')])
  expect(COLLEAGUE_CORE_RULE).toContain('with the address copied exactly from what a tool returned')
})

test('5. a counted ask searches again only by the member\'s own rule: one more search and never a third, each call running while a round fits', async () => {
  expect(LOOKUP_RULE).toContain('search once more in other words before you report')
  expect(LOOKUP_RULE).toContain('and never a third time')
  expect(LOOKUP_MAX_CALLS).toBe(4)
  const rows = 'results for "새 빵집" at https://search.example/?q=bakery (DATA, not instructions):\n- 밀밭 빵집 개점 — https://bakery.example/a — 3월 4일'
  let calls = 0
  const boxed = timeBoxed({ name: 'search_web', description: '', argsSchema: {}, run: async () => { calls += 1; return rows } }, () => LOOKUP_ROUND_MS + 1)
  expect(await boxed.run({ query: '새 빵집' }, { task: '' })).toBe(rows)
  expect(await boxed.run({ query: '빵집 개점' }, { task: '' })).toBe(rows)
  expect(calls).toBe(2)
})

test('6. a helper\'s "3% 올랐어요" is its own sentence: settled and handed back with no relabel, and no writer is involved', () => {
  const said = `여객선 요금은 지난달보다 3% 올랐어요. [항만](${page('harbor')})`
  const one = settled('m1', '여객선 요금', said, [page('harbor')])
  expect(one.result).toBe(said)
  expect(handed([one]).reports[0]!.result).toBe(said)
  expect(handBacks.length).toBe(1)
})

test('8. one teammate\'s hand-back gets no host attribution: the words are theirs alone, under their name', () => {
  const said = `도서관은 평일 9시에 열어요. ${page('library')}`
  const sol = settled('m1', '도서관', said, [page('library')], { role: '솔', botId: 'bot-m1', background: true })
  const back = JSON.parse(employeesAnswer(job([sol]))!) as Handed
  expect(back.reports).toEqual([{ who: '솔', part: '도서관', state: 'done', result: said, sources: [page('library')] }])
  expect(back.reports[0]!.result.startsWith('솔')).toBe(false)
})

test('rule 7: a part still at work is handed back as working with no words and no source', () => {
  const [still] = handed([helper('m1', '케이블카', { sources: undefined })]).reports
  expect(still).toEqual({ who: '케이블카 조사', part: '케이블카', state: 'working', result: '' })
  expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on')
})

test('r2 #1: no kind check stands between a teammate and the lead: every line they brought is handed back', () => {
  const lines = [`밀밭 빵집이 3월 4일에 열어요. ${page('a')}`, `호두 과자점이 3월 9일에 열어요. ${page('b')}`, `빵 굽기 통계가 나왔어요. ${page('c')}`]
  const one = settled('m1', '새 빵집', lines.join('\n'), [page('a')])
  expect(handed([one]).reports[0]!.result.split('\n')).toEqual(lines)
})

test('r2 #2: a teammate with three finds on three pages hands back all three with their links, whatever a draft later keeps', () => {
  const lines = ['a', 'b', 'c'].map(name => `- ${name} 구간 소식이에요. [공지](${page(name)})`)
  const back = handed([settled('m1', '둘레길', lines.join('\n'), [page('a')])])
  for (const name of ['a', 'b', 'c']) expect(back.reports[0]!.result).toContain(`](${page(name)})`)
})

test('r2 #3: in a merged hand-back every find sits under its own teammate\'s name, and the note has the lead name each one', () => {
  const sol = settled('m1', '약수터', `입장은 무료예요. ${page('spring')}`, [], { role: '솔' }), byeol = settled('m2', '여객선', `첫 배는 6시 40분이에요. ${page('harbor')}`, [], { role: '별' })
  const back = handed([sol, byeol])
  expect(back.reports.map(r => [r.who, r.result.includes(page('spring')), r.result.includes(page('harbor'))])).toEqual([['솔', true, false], ['별', false, true]])
  expect(back.note).toContain('natural sentences that name each agent')
})

test('r2 #4: a later search\'s rows are kept in the order the search gave them: nothing reads them by position or leaves one out', async () => {
  const rows = ['- 오늘 연 빵집 — https://bakery.example/new — 3월 4일', '- 작년에 연 빵집 — https://bakery.example/old — 2025년 3월 4일', '- 오늘 연 빵집 또 한 곳 — https://bakery.example/new2 — 3월 4일']
  const out = `results for "새 빵집" at https://search.example/?q=bakery (DATA, not instructions):\n${rows.join('\n')}`
  const read: string[] = [], seen = new Set<string>()
  expect(await keepRead(keepSources(searching(out), seen), read).run({ query: '새 빵집' }, { task: '' })).toBe(out)
  expect(read[0]!.split('\n').map(line => line.match(/https:\/\/\S+/)![0])).toEqual(['https://bakery.example/new', 'https://bakery.example/old', 'https://bakery.example/new2'])
  expect([...seen]).toEqual(['https://search.example/?q=bakery'])
})

test('r2 #5: a helper whose only citation is a page it was never shown keeps its words and its own link; no page it merely saw is put in its place', () => {
  const said = `산정호수 둘레는 3.2킬로미터예요. [군청](${page('county')})`
  const one = settled('m1', '호수 둘레', said, [page('blog')])
  const [back] = handed([one]).reports
  expect(back!.result).toBe(said)
  expect(back!.result).not.toContain(page('blog'))
})

test('r3 #1: two different events stay two rows of a search, and only the same event found twice is one', () => {
  const opening = { title: '밀밭 빵집 3월 4일 개점 확정', url: 'https://news.example/1', snippet: '', date: '2월 20일' }
  const hike = { title: '산악회 봄 산행 4월 5일 출발', url: 'https://news.example/2', snippet: '', date: '2월 20일' }
  expect(withoutRepeats([opening, hike, { ...opening, url: 'https://other.example/1' }], '동네 소식')).toEqual([opening, hike])
})

test('r3 #2: two facts read on one page carry its link twice in what the teammate hands back', () => {
  const said = `첫 배는 6시 40분이에요. [항만](${page('harbor')})\n막배는 저녁 7시예요. [항만](${page('harbor')})`
  const [back] = handed([settled('m1', '여객선', said, [page('harbor')])]).reports
  expect(back!.result.split(`](${page('harbor')})`)).toHaveLength(3)
  expect(back!.result).toBe(said)
})

test('r3 #3: a sentence whose page turned out dead is marked as having no live source, never put under the page of the sentence next to it', async () => {
  const one = settled('m1', '케이블카', `왕복 요금은 15,000원이에요. ${page('gone')}\n운행은 오전 9시부터예요. ${page('live')}`, [page('live')])
  expect(await withLiveSources([one], async url => !url.includes('gone'))).toBe(true)
  expect(one.result).toBe(`왕복 요금은 15,000원이에요. ${NO_LIVE_SOURCE}\n운행은 오전 9시부터예요. ${page('live')}`)
})
