import { expect, it, vi } from 'vitest'
import type { EngramEvent } from '../src/shared/types.js'

const fixture = vi.hoisted(() => ({
  receive: (() => {}) as (event: EngramEvent) => void,
  botTranscript: vi.fn(),
}))
vi.mock('../src/renderer/src/api.js', () => ({ api: {
  onEvent: (receive: (event: EngramEvent) => void) => { fixture.receive = receive },
  botTranscript: fixture.botTranscript,
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
