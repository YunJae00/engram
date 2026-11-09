import { expect, it } from 'vitest'
import { conversation } from '../src/agent-history.js'
import { withoutReplies } from '../src/index.js'

it('carries earlier answers whole while there is room, newest first', () => {
  const found = 'The leave balance is on PageOne → Workday → Time Off: 15 days left. '.repeat(10)
  const history = [
    { role: 'user' as const, text: 'How many leave days do I have left?' },
    { role: 'assistant' as const, text: found },
    ...Array.from({ length: 8 }, (_, at) => ({ role: (at % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${at}` })),
  ]
  const lines = conversation(history).join('\n')
  expect(lines).toContain(`You: ${found.slice(0, 2_000)}`)
  expect(lines).not.toContain('Earlier requests in this conversation')
})

it('keeps the latest four turns and sends older ones as requests when the room runs out', () => {
  const long = 'x'.repeat(15_000)
  const history = Array.from({ length: 10 }, (_, at) => ({ role: (at % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `${at} ${long}` }))
  const lines = conversation(history)
  const recent = lines.at(-1)!.split('\n').filter(line => /^(User|You):/.test(line))
  expect(recent.length).toBeGreaterThanOrEqual(4)
  expect(recent.at(-1)).toMatch(/^You: 9 /)
  expect(lines.join('\n')).toContain('Earlier requests in this conversation')
  expect(lines.join('\n')).toContain('User: 0 ')
})

it('retains a verified URL and total beyond the former assistant cutoff', () => {
  const text = 'explanation '.repeat(500) + '\nVerified total 393: https://example.test/report'
  expect(conversation([{ role: 'assistant', text }]).join('\n')).toContain('Verified total 393: https://example.test/report')
})

it('keeps the observation time in conversation history', () => {
  expect(conversation([{ role: 'user', text: 'Read Claude', at: '2026-11-02T10:28:08.000Z' }]).join('\n')).toContain('[2026-11-02 10:28Z] User: Read Claude')
})

const invented = '다음 회의 날짜는 11월 14일이야'
const asked = `메모에 기한이 없어요.\n\n다음 회의 날짜를 알고 계신가요?\n\n\`\`\`replies\n${invented}\n기한 아직 모름\n\`\`\``

it('leaves suggested replies out of recent assistant turns', () => {
  const text = conversation([{ role: 'user', text: '기한도 같이 넣어줘' }, { role: 'assistant', text: asked }]).join('\n')
  expect(text).toContain('다음 회의 날짜를 알고 계신가요?')
  expect(text).not.toContain('```replies')
  expect(text).not.toContain('11월 14일')
})

it('leaves suggested replies out of earlier assistant turns', () => {
  const long = 'x'.repeat(15_000)
  const history = [
    { role: 'user' as const, text: '기한도 같이 넣어줘' },
    { role: 'assistant' as const, text: asked },
    ...Array.from({ length: 5 }, (_, at) => ({ role: (at % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `${at} ${long}` })),
  ]
  const text = conversation(history).join('\n')
  expect(text).toContain('Earlier requests in this conversation')
  expect(text).toContain('다음 회의 날짜를 알고 계신가요?')
  expect(text).not.toContain('```replies')
  expect(text).not.toContain('11월 14일')
})

it('strips an unclosed replies block', () => {
  const text = conversation([{ role: 'assistant', text: `정리했어요.\n\`\`\`replies\n${invented}` }]).join('\n')
  expect(text).toContain('You: 정리했어요.')
  expect(text).not.toContain('11월 14일')
})

it('keeps a clicked chip as the person\'s own words', () => {
  expect(conversation([{ role: 'user', text: invented }]).join('\n')).toContain(`User: ${invented}`)
})

it('strips every replies block from a text, closed or not', () => {
  expect(withoutReplies('A\n```replies\nx\n```\nB\n```replies\ny\n```')).toBe('A\nB')
  expect(withoutReplies('A\n```replies\nx\n```\nB\n```replies\ny')).toBe('A\nB')
  expect(withoutReplies('A\n```ts\nconst x = 1\n```')).toBe('A\n```ts\nconst x = 1\n```')
})

it('strips many replies blocks in one pass without exhausting memory', () => {
  const text = 'line\n```replies\nchip\n```\n'.repeat(10_000)
  expect(withoutReplies(text)).toBe(Array(10_000).fill('line').join('\n'))
})
