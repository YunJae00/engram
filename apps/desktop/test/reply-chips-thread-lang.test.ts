import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

(globalThis as { window?: unknown }).window ??= { engram: {} }
const { CometMessages } = await import('../src/renderer/src/components/CometMessages.js')
import type { CometMessage } from '../src/renderer/src/lib/cometThreads.js'

const chips = (messages: CometMessage[]) => [...renderToStaticMarkup(createElement(CometMessages, {
  messages, busy: false, status: '', workLines: [], keptWork: [], onReply: () => true,
})).matchAll(/class="reply-chip"[^>]*>([^<]*)</g)].map(m => m[1])

it('an English-only answer in a Korean thread still offers Korean reply chips', () => {
  const english = chips([
    { role: 'user', text: '봇 세 개 만들어서 앱 테스트하게 해줘' },
    { role: 'assistant', text: 'Please sign in or complete the check in the open page, then tell me when it is done.' },
  ] as CometMessage[])
  expect(english.length).toBeGreaterThan(0)
  for (const label of english) expect(label).toMatch(/[가-힣]/)
})
