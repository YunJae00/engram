import { expect, it } from 'vitest'
import { withSteer } from '../src/agent-session.js'

it('hands words sent mid-turn to the brain with the next tool result, once, and leaves results alone otherwise', () => {
  expect(withSteer('page read', [])).toBe('page read')
  const text = withSteer('page read', ['서울만 봐줘', 'Also check prices'])
  expect(text.startsWith('page read')).toBe(true)
  expect(text).toContain('"서울만 봐줘", then "Also check prices"')
  expect(text).toContain('First answer them in one short line')
})
