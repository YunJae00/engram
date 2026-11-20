import { expect, test } from 'vitest'
import { handBacks } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'

const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '하람', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })

test('a schedule hand-back reaches the result step as written: dated and undated lines both stay, and the host adds no count of its own', () => {
  const result = ['- 12월 6일 시민 합창단 송년 음악회가 열려요. https://choir.example/winter',
    '- 성당 성가대 정기 공연도 12월 중이라는데 날짜는 아직 없어요. https://chant.example/news',
    '- 동네 합창 모임 공연 몇 개가 한 페이지에 모여 있어요. https://chorus.example/list'].join('\n')
  const sources = ['https://choir.example/winter', 'https://chant.example/news', 'https://chorus.example/list']
  const sent = JSON.parse(handBacks([member({ brief: '다음 달 합창 공연 일정 정리', topic: '합창 공연', result, sources })])) as { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[] }
  expect(sent.reports).toEqual([{ who: '하람', part: '합창 공연', state: 'done', result, sources }])
  expect(JSON.stringify(sent)).not.toMatch(/\d개를|\d건/)
})
