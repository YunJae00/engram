import { describe, expect, it } from 'vitest'
import { keepRead, keepSources, LOOKUP_RULE, skipWalls, TEAM_ANSWER_MS, timeBoxed } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (n: number, title: string, host = 'garden.example'): string => `- ${title} — https://${host}/${n} — x — 4월 ${n}일`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? '' } }
}
const asMember = (tool: AgentTool, kept: string[] = []): AgentTool => timeBoxed(keepRead(keepSources(skipWalls(tool), new Set()), kept), () => TEAM_ANSWER_MS)

describe('c15a r2: search rows reach the teammate as the search gave them', () => {
  it('two rows about the same seed sale, one from a blog and one from the grower, both reach the teammate unchanged', async () => {
    const raw = page('q', [row(1, '초록농원 토마토 모종 할인한대요 (블로그)', 'blog.example'), row(2, '초록농원, 토마토 모종 4월 5일 할인 시작', 'grower.example')])
    const s = search([raw])
    expect(await asMember(s).run({ query: 'q' }, { task: '초록농원 모종 할인일 하나만' })).toBe(raw)
  })

  it('a sure and an unsure row stay in the search\'s order, with nothing added or removed by the host', async () => {
    const raw = page('q', [row(1, '해바라기 정원 개장?'), row(2, '도심 해바라기 정원 개장 안내')])
    const out = await asMember(search([raw])).run({ query: 'q' }, { task: '해바라기 정원 개장 소식 1건' })
    expect(out).toBe(raw)
  })

  it('a counted ask short of rows starts no host search: only the searches the teammate asks for run, and the rule tells it to look once more in other words', async () => {
    const s = search([page('허브 화분', [row(1, '허브 화분 박람회')]), page('허브 화분 분양 행사', [row(2, '라벤더 화분 분양'), row(3, '로즈마리 화분 나눔')])])
    const tool = asMember(s)
    const first = await tool.run({ query: '허브 화분' }, { task: '허브 화분 분양 행사 2건' })
    expect(s.queries).toEqual(['허브 화분'])
    expect(first).toContain('https://garden.example/1')
    const second = await tool.run({ query: '허브 화분 분양 행사' }, { task: '허브 화분 분양 행사 2건' })
    expect(s.queries).toEqual(['허브 화분', '허브 화분 분양 행사'])
    expect(second).toContain('https://garden.example/3')
    expect(LOOKUP_RULE).toContain('search once more in other words')
  })

  it('a first search with no rows comes back empty as it is; looking again is the teammate\'s own next search', async () => {
    const empty = page('정원 도구', [])
    const s = search([empty, page('정원 가위 할인', [row(1, '정원 가위 반값'), row(2, '전지가위 특가'), row(3, '모종삽 세트 할인')])])
    const tool = asMember(s)
    expect(await tool.run({ query: '정원 도구' }, { task: '정원 도구 할인 3개' })).toBe(empty)
    expect(s.queries).toEqual(['정원 도구'])
    expect((await tool.run({ query: '정원 가위 할인' }, { task: '정원 도구 할인 3개' })).match(/^- /gm)).toHaveLength(3)
  })
})
