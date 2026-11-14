import { expect, it } from 'vitest'
import { pageTools } from '../src/comet-page-tools.js'
import type { WebCourier } from '../src/errand.js'

const wall = { url: 'https://example.test/login', title: 'Sign in', text: 'Sign in', wall: 'login' as const }
const courier = { fetchPage: async () => wall, readOpen: async () => wall, press: async () => ({ ok: true, changed: true }) } as unknown as WebCourier

const handoff = async (task: string): Promise<string> => {
  const press = pageTools({}, courier).find(tool => tool.name === 'press')!
  const out = await press.run({ target: 'Continue' }, { task, signal: new AbortController().signal } as never)
  return typeof out === 'string' ? out : (out as { text: string }).text
}

it('a sign-in wall after a page move asks in Korean in a Korean task', async () => {
  const text = await handoff('보고서를 열어줘')
  expect(/this question: (.*?) Then stop/.exec(text)?.[1]).toMatch(/[가-힣]/)
})

it('keeps the English question in an English task', async () => {
  expect(await handoff('Open the report')).toContain('Can you complete the sign-in or check in the open page')
})
