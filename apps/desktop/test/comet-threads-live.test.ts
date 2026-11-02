import { expect, it, vi } from 'vitest'
import type { EngramEvent } from '../src/shared/types.js'

const fixture = vi.hoisted(() => ({
  listeners: new Set<(event: EngramEvent) => void>(),
  receive: (event: EngramEvent) => { for (const listener of fixture.listeners) listener(event) },
  botTranscript: vi.fn(),
  chatSend: vi.fn(async () => undefined),
}))
vi.mock('../src/renderer/src/api.js', () => ({ api: {
  onEvent: (receive: (event: EngramEvent) => void) => { fixture.listeners.add(receive); return () => { fixture.listeners.delete(receive) } },
  botTranscript: fixture.botTranscript,
  chatSend: fixture.chatSend,
  chatActive: async () => [],
} }))
vi.mock('../src/renderer/src/lib/webPane.js', () => ({ webPane: { handleEvent: () => {} } }))
import { cometThreads } from '../src/renderer/src/lib/cometThreadsLive.js'

it('reloads the complete transcript after task release invalidates an adopted answer load', async () => {
  const turns = [{ role: 'user', text: 'Read the report' }, { role: 'assistant', text: 'Done' }]
  let oldRead!: (value: typeof turns) => void
  fixture.botTranscript.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve })).mockResolvedValue(turns)
  fixture.receive({ type: 'comet:working', channel: 'bot-reloaded', working: true })
  fixture.receive({ type: 'chat:done', channel: 'bot-reloaded', text: 'Done' })
  fixture.receive({ type: 'comet:working', channel: 'bot-reloaded', working: false })
  oldRead([])
  await vi.waitFor(() => expect(cometThreads.thread('reloaded').messages.map(m => m.text)).toEqual(['Read the report', 'Done']))
  expect(cometThreads.thread('reloaded').busy).toBe(false)
})

it('waits for the full adopted transcript before dispatching a queued follow-up', async () => {
  let finishRead!: (value: { role: 'user' | 'assistant'; text: string }[]) => void
  fixture.botTranscript.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
  cometThreads.adopt('queued-reload')
  cometThreads.enqueue('queued-reload', 'Next question')
  fixture.receive({ type: 'chat:done', channel: 'bot-queued-reload', text: 'Previous answer' })
  await Promise.resolve()
  expect(fixture.chatSend).not.toHaveBeenCalled()
  finishRead([{ role: 'user', text: 'Previous question' }, { role: 'assistant', text: 'Previous answer' }])
  await vi.waitFor(() => expect(fixture.chatSend).toHaveBeenCalledOnce())
  expect(fixture.chatSend.mock.calls[0]?.[0]).toMatchObject({ history: [{ role: 'user', text: 'Previous question' }, { role: 'assistant', text: 'Previous answer' }], message: 'Next question' })
})

it('keeps Stop authoritative after a late completion echo and working notification', () => {
  cometThreads.begin('stopped-echo', 'Read the app')
  fixture.receive({ type: 'comet:working', channel: 'bot-stopped-echo', working: true })
  cometThreads.stop('stopped-echo', 'Stopped')
  fixture.receive({ type: 'chat:done', channel: 'bot-stopped-echo', text: 'Late answer' })
  fixture.receive({ type: 'comet:working', channel: 'bot-stopped-echo', working: true })
  expect(cometThreads.thread('stopped-echo').busy).toBe(false)
  expect(cometThreads.thread('stopped-echo').messages.at(-1)?.text).toBe('Stopped')
  cometThreads.begin('stopped-echo', 'Read again')
  expect(cometThreads.thread('stopped-echo').busy).toBe(true)
})
