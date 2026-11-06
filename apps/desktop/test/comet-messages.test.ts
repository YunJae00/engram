import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createCometThreads, type CometThread } from '../src/renderer/src/lib/cometThreads.js'
import { pendingStatus } from '../src/renderer/src/lib/pendingStatus.js'
import { threadT } from '../src/renderer/src/lib/threadLang.js'

vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
import { CometMessages } from '../src/renderer/src/components/CometMessages.js'

const work = ['page_do: web edit', 'press: click Save', 'verification: recheck the page', 'task_plan: plan the edits', 'unknown_tool: internal arguments']
const turns = [
  { role: 'user' as const, text: 'Update the page.' },
  { role: 'assistant' as const, text: 'The page is updated.', work: [...work, 'said: I found the page.', 'you: Keep the heading.'] },
]
const render = (thread: CometThread) => renderToStaticMarkup(createElement(CometMessages, {
  ...thread, status: pendingStatus(threadT('en'), thread.workLines.at(-1)), onReply() {},
}))
const expectNoActivity = (html: string) => {
  for (const text of [...work, 'comet-work-card', 'comet-work-toggle', 'bots-work-steps', 'Browsing the web', 'Planning the work']) expect(html).not.toContain(text)
}

describe('conversation activity', () => {
  it('preserves conversation text while hiding persisted tool history and legacy kept work', () => {
    const store = createCometThreads(null)
    store.load('one', turns)
    const html = render(store.thread('one'))
    expectNoActivity(html)
    for (const text of ['Update the page.', 'The page is updated.', 'I found the page.', 'Keep the heading.']) expect(html).toContain(text)
    expect(html).not.toContain('bots-thinking')
    const legacy = { ...store.thread('one'), messages: turns.map(({ role, text }) => ({ role, text })), keptWork: work }
    expectNoActivity(render(legacy))
    expect(store.thread('one').messages[1]!.work).toEqual(turns[1]!.work)
  })

  it('shows one current status after the conversation and clears it on completion and reload', () => {
    const store = createCometThreads(null)
    store.load('one', turns)
    store.begin('one', 'Check it again.')
    for (const [line, label] of [['page_do: web edit', 'Working through the page'], ['task_plan: plan the edits', 'Planning the steps']]) {
      store.handleEvent({ type: 'comet:step', channel: 'bot-one', line: line! })
      const html = render(store.thread('one'))
      expectNoActivity(html)
      expect(html.match(/data-testid="bots-thinking"/g)).toHaveLength(1)
      expect(html).toContain(label)
      expect(html.indexOf('bots-thinking')).toBeGreaterThan(html.indexOf('Check it again.'))
    }
    store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Checked and complete.' })
    const completed = store.thread('one')
    expect(completed.keptWork).toHaveLength(2)
    const reloaded = createCometThreads(null)
    reloaded.load('one', completed.messages)
    for (const thread of [completed, reloaded.thread('one')]) {
      const html = render(thread)
      expectNoActivity(html)
      expect(html).toContain('Checked and complete.')
      expect(html).not.toContain('bots-thinking')
      expect(html).not.toContain('Planning the steps')
    }
  })
})
