import { expect, it } from 'vitest'
import { withSteer } from '../src/agent-session.js'

it('hands words sent mid-turn to the brain with the next tool result, once, and leaves results alone otherwise', () => {
  expect(withSteer('page read', [])).toBe('page read')
  const text = withSteer('page read', ['서울만 봐줘', 'Also check prices'])
  expect(text.startsWith('page read')).toBe(true)
  expect(text).toContain('"서울만 봐줘", then "Also check prices"')
  expect(text).toContain('First answer them in one short line')
})

it('asks the brain itself to answer an addition, a replacement and a remark in one line, since no host line answers them, and opens with the words when there is no tool result', () => {
  const said = ['목포도 끼워 줘', '그냥 여수로 해', '다들 고생이 많네']
  const texts = said.map(one => withSteer('page read', [one]))
  for (const [at, text] of texts.entries()) {
    expect(text.startsWith('page read\n\n')).toBe(true)
    expect(text).toContain(JSON.stringify(said[at]))
    expect(text).toContain('First answer them in one short line')
    expect(text).not.toContain('already told')
  }
  expect(new Set(texts.map((text, at) => text.replace(JSON.stringify(said[at]), 'X'))).size).toBe(1)
  expect(withSteer('', ['목포도 끼워 줘']).startsWith('The person just wrote, while you work: "목포도 끼워 줘".')).toBe(true)
})
