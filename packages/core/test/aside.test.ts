import { expect, it } from 'vitest'
import { asidePrompt, parseAside } from '../src/aside.js'

it('answers from the work done so far and in the language of the message', () => {
  const prompt = asidePrompt({ goal: '이번 주 날씨 알려줘', work: ['opened weather site', 'reading Seoul forecast'], said: [{ role: 'user', text: '이번 주 날씨 알려줘' }], message: '부산도 같이 봐줘' })
  expect(prompt).toContain('- reading Seoul forecast')
  expect(prompt).toContain('They said now: 부산도 같이 봐줘')
  expect(prompt).toContain('in the language of their message')
})

it('reads the decision, and a relay with nothing to relay is only a reply', () => {
  expect(parseAside('{"reply":"부산도 볼게요.","action":"relay","instruction":"부산 날씨도 함께 확인"}')).toEqual({ reply: '부산도 볼게요.', action: 'relay', instruction: '부산 날씨도 함께 확인' })
  expect(parseAside('{"reply":"멈출게요.","action":"stop"}')).toEqual({ reply: '멈출게요.', action: 'stop' })
  expect(parseAside('{"reply":"네","action":"relay"}')).toEqual({ reply: '네', action: 'none' })
  expect(parseAside('{"reply":"","action":"none"}')).toBeNull()
  expect(parseAside('not json')).toBeNull()
})
