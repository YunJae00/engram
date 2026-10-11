import { beforeEach, expect, it, vi } from 'vitest'
let webPane: typeof import('../src/renderer/src/lib/webPane.js').webPane
beforeEach(async () => { vi.resetModules(); webPane = (await import('../src/renderer/src/lib/webPane.js')).webPane })
const step = (channel: string, tool: string) => webPane.handleEvent({ type: 'comet:step', channel, line: `${tool}: page` })
it('opens actual browser tools in their own chat, preserving each fold and phase through parallel work', () => {
  expect(step('a', 'open_page')).toBe(true)
  expect(webPane.getSnapshot('a')).toEqual({ folded: false, wanted: true, expanded: false, floating: true, phase: 'working' })
  expect(webPane.getSnapshot('b')).toEqual({ folded: false, wanted: false, expanded: false, floating: false, phase: 'idle' })
  webPane.fold('a')
  expect(step('b', 'read_open_page')).toBe(true)
  expect(step('a', 'scroll')).toBe(false)
  expect(webPane.getSnapshot('a').folded).toBe(true)
  expect(webPane.getSnapshot('b').folded).toBe(false)
  step('a', 'aside')
  expect(webPane.getSnapshot('a').phase).toBe('aside')
  expect(webPane.getSnapshot('b').phase).toBe('working')
  step('a', 'resume')
  step('a', 'excel_write')
  expect(webPane.getSnapshot('a').phase).toBe('idle')
  expect(step('a', 'open_page')).toBe(true)
  expect(webPane.getSnapshot('a').folded).toBe(false)
  webPane.handleEvent({ type: 'chat:error', channel: 'b', message: 'Stopped' })
  expect(webPane.getSnapshot('b')).toEqual({ folded: false, wanted: true, expanded: false, floating: true, phase: 'idle' })
  expect(webPane.getSnapshot('a').phase).toBe('working')
})
it('does not mistake memory reads or app launching for browser work', () => {
  for (const tool of ['open_skill', 'read_note', 'open_app', 'read_live_document']) expect(step('a', tool)).toBe(false)
  expect(webPane.getSnapshot('a').wanted).toBe(false)
})
it('keeps expanded mode per conversation and returns to chat when folded', () => {
  webPane.open('a'); webPane.expand('a', true)
  expect(webPane.getSnapshot('a').expanded).toBe(true)
  expect(webPane.getSnapshot('b').expanded).toBe(false)
  webPane.fold('a')
  expect(webPane.getSnapshot('a').expanded).toBe(false)
})
it('starts automatic work in preview but keeps a chosen layout during that work', () => {
  step('a', 'open_page')
  expect(webPane.getSnapshot('a').floating).toBe(true)
  webPane.open('a')
  step('a', 'read_open_page')
  expect(webPane.getSnapshot('a')).toMatchObject({ floating: false, expanded: false })
  webPane.expand('a', true)
  step('a', 'scroll')
  expect(webPane.getSnapshot('a').expanded).toBe(true)
  webPane.preview('a'); webPane.fold('a')
  step('a', 'press')
  expect(webPane.getSnapshot('a')).toMatchObject({ floating: true, folded: true, expanded: false })
  webPane.preview('a')
  expect(webPane.getSnapshot('a').folded).toBe(false)
})
it('brings chat back for approvals and questions without interrupting the work', () => {
  for (const event of [
    { type: 'press:ask', channel: 'a', words: 'Submit', host: 'example.com' },
    { type: 'chat:offer', channel: 'a', offer: { kind: 'asked', question: 'Which file?', options: ['A', 'B'] } },
  ] as const) {
    webPane.expand('a', true)
    webPane.handleEvent(event)
    expect(webPane.getSnapshot('a')).toMatchObject({ expanded: false, floating: true })
  }
  webPane.open('a'); webPane.attention('a')
  expect(webPane.getSnapshot('a').floating).toBe(false)
  expect(webPane.getSnapshot('b').wanted).toBe(false)
})
