import { expect, it } from 'vitest'
import { withSteer } from '../src/agent-session.js'

it('hands words sent mid-turn to the brain with the next tool result, once, and leaves results alone otherwise', () => {
  expect(withSteer('page read', [])).toBe('page read')
  const text = withSteer('page read', ['서울만 봐줘', 'Also check prices'])
  expect(text.startsWith('page read')).toBe(true)
  expect(text).toContain('"서울만 봐줘", then "Also check prices"')
  expect(text).toContain('First answer them in one short line')
})

it('tells the brain the person was already answered when the host replied, for an addition, a replacement and a remark', () => {
  const text = withSteer('page read', ['아 대구도 추가해'], true)
  expect(text.startsWith('page read')).toBe(true)
  expect(text).toContain('"아 대구도 추가해"')
  expect(text).toContain('They were already told in one short line that you got it')
  expect(text).toContain('write nothing before your next step')
  expect(text).toContain('one answer that covers everything')
  expect(text).toContain('leave the replaced one out of the answer')
  expect(text).toContain('go on unchanged')
  expect(text).not.toContain('First answer them')
  expect(withSteer('page read', [], true)).toBe('page read')
})
