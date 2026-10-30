import { expect, it, vi } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

it('batches three streams while delivering completion immediately without dropping tokens', () => {
  vi.useFakeTimers()
  try {
    const store = createCometThreads('one')
    for (const id of ['one', 'two', 'three']) store.begin(id, 'Read')
    const listener = vi.fn()
    store.subscribe(listener)
    for (let i = 0; i < 100; i++) for (const id of ['one', 'two', 'three']) store.handleEvent({ type: 'chat:token', channel: `bot-${id}`, text: 'x' })
    expect(listener).not.toHaveBeenCalled()
    vi.advanceTimersByTime(80)
    expect(listener).toHaveBeenCalledTimes(1)
    for (const id of ['one', 'two', 'three']) expect(store.thread(id).messages.at(-1)?.text).toBe('x'.repeat(100))
    store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'tail' })
    store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Complete' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.thread('one').messages.at(-1)?.text).toBe('Complete')
    vi.advanceTimersByTime(80)
    expect(listener).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})
