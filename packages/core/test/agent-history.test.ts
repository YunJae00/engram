import { expect, it } from 'vitest'
import { conversation } from '../src/agent-history.js'

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
  const long = 'x'.repeat(5_000)
  const history = Array.from({ length: 10 }, (_, at) => ({ role: (at % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `${at} ${long}` }))
  const lines = conversation(history)
  const recent = lines.at(-1)!.split('\n')
  expect(recent.length).toBeGreaterThanOrEqual(4)
  expect(recent.at(-1)).toMatch(/^You: 9 /)
  expect(lines.join('\n')).toContain('Earlier requests in this conversation')
  expect(lines.join('\n')).toContain('User: 0 ')
})
