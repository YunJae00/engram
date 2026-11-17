import { expect, test } from 'vitest'
import { mergedReport } from '../src/company-tools.js'
import type { MemberFact, TeamMember } from '../src/delegated-tasks.js'

const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '하린', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })
const fact = (text: string, url: string, date?: string): MemberFact => ({ text, url, site: new URL(url).host, ...(date ? { date } : {}) })

test('stack-10 (c10b run C5): a schedule counts the items that give a day; the others stay listed, uncounted (c11a: structure)', () => {
  const facts = [fact('부산 클라우드 밋업이 벡스코에서 열려요.', 'https://bexco.example/cloud', '12월 9일'),
    fact('12월 중 부산 AI 위크도 열리는데 날짜는 아직 안 나왔어요.', 'https://busan-ai.example/week'),
    fact('연말 개발자 세미나 몇 개가 모여 있는데 개별 날짜는 없어요.', 'https://devlist.example/seminars')]
  const said = mergedReport([member({ brief: '다음 달 부산 IT 행사 일정 정리', data: { facts } })])
  // The teammate is named on the part's head; every item stays listed, each with its own link named by its site, none counted by template.
  expect(said.split('\n')[0]).toMatch(/\(하린\):$/)
  expect(said.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3)
  expect(said).toContain('12월 9일')
  expect(said).toContain('부산 AI 위크')
  expect(said).toContain('개발자 세미나')
  for (const f of facts) expect(said).toContain(`[${f.site}](${f.url})`)
  expect(said).not.toContain('출처')
  expect(said).not.toMatch(/(?<!\]\()https?:\/\//)
  // Two with their days are two listed items.
  const two = mergedReport([member({ brief: '다음 달 부산 IT 행사 일정 정리', data: { facts: [fact('클라우드 밋업', 'https://a.example/1', '12월 9일'), fact('보안 콘퍼런스', 'https://b.example/2', '12월 16일')] } })])
  expect(two.split('\n').filter(line => /^- 12월 (?:9|16)일 .+\]\(https:\/\/[ab]\.example\/[12]\)$/.test(line))).toHaveLength(2)
})
