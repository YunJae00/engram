import { expect, it } from 'vitest'
import { interviewPrompt } from '../src/work-guide.js'

it('asks in the language it is given, and in the evidence language without one', () => {
  const sources = [{ id: 'place:tms', kind: 'place' as const, label: '프로젝트 모니터링과 근무시간 보고', grounding: {} }]
  expect(interviewPrompt({ sources, language: 'Korean' })).toContain('Write every question, basis and option in Korean;')
  expect(interviewPrompt({ sources })).toContain('in the language the person writes in')
})
