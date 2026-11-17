import { expect, test } from 'vitest'
import { mergedReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'

const NOV17 = new Date(2026, 10, 17, 12)
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '하린', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })

test('stack-10 (c10b run C5): a schedule counts the items that give a day; the others stay listed, uncounted', () => {
  const result = ['12월 9일 부산 클라우드 밋업이 벡스코에서 열려요. https://bexco.example/cloud',
    '12월 중 부산 AI 위크도 열리는데 날짜는 아직 안 나왔어요. https://busan-ai.example/week',
    '연말 개발자 세미나 몇 개가 모여 있는데 개별 날짜는 없어요. https://devlist.example/seminars'].join('\n')
  const said = mergedReport([member({ brief: '다음 달 부산 IT 행사 일정 정리', result, sources: ['https://bexco.example/cloud'] })], undefined, [], { ask: '이거 하린한테 맡겨: 다음 달 부산 IT 행사 일정 정리', now: NOV17 })
  expect(said.split('\n')[0]).toBe('하린: 12월 부산 IT 행사는 확실한 건 하나예요.')
  expect(said).toContain('부산 AI 위크')
  expect(said).toContain('개발자 세미나')
  // Two with their days are counted as two.
  const two = mergedReport([member({ brief: '다음 달 부산 IT 행사 일정 정리', result: '12월 9일 클라우드 밋업 https://a.example/1\n12월 16일 보안 콘퍼런스 https://b.example/2', sources: [] })], undefined, [], { ask: '다음 달 부산 IT 행사 일정 정리', now: NOV17 })
  expect(two.split('\n')[0]).toMatch(/두 개 (?:있어요|나와요)\.$/)
})
