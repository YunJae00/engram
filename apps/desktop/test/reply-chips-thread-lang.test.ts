import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

(globalThis as { window?: unknown }).window ??= { engram: {} }
const { CometMessages } = await import('../src/renderer/src/components/CometMessages.js')
import type { CometMessage } from '../src/renderer/src/lib/cometThreads.js'

const shown = (messages: CometMessage[]) => renderToStaticMarkup(createElement(CometMessages, { messages, busy: false, status: '', workLines: [], keptWork: [] }))

it('an answer offers no reply chips, in a Korean thread or an English one', () => {
  const korean = shown([
    { role: 'user', text: '봇 세 개 만들어서 앱 테스트하게 해줘' },
    { role: 'assistant', text: 'Please sign in or complete the check in the open page, then tell me when it is done.' },
  ] as CometMessage[])
  const english = shown([
    { role: 'user', text: 'Which one should I pick?' },
    { role: 'assistant', text: 'Would you like A or B?' },
  ] as CometMessage[])
  for (const html of [korean, english]) {
    expect(html).toContain('bubble-msg assistant')
    expect(html).not.toContain('reply-chip')
  }
})
