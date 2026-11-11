import { describe, expect, it } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { startOver } from '../src/renderer/src/lib/freshStart.js'
import type { ChatTurnDto } from '../src/shared/types.js'

describe('startOver', () => {
  it('confirm then archive keeps memory: chatFresh once with the bot id, then the thread empties', async () => {
    const calls: string[] = []
    const api = { chatFresh: async (id: string) => { calls.push(`chatFresh:${id}`) } }
    await startOver(api, { fresh: id => { calls.push(`fresh:${id}`) } }, 'bot-1')
    expect(calls).toEqual(['chatFresh:bot-1', 'fresh:bot-1'])
  })

  it('a failed chatFresh leaves the thread as it was', async () => {
    const failure = new Error('archive failed')
    const fresh: string[] = []
    const api = { chatFresh: async () => { throw failure } }
    await expect(startOver(api, { fresh: id => { fresh.push(id) } }, 'bot-1')).rejects.toBe(failure)
    expect(fresh).toEqual([])
  })

  it('a transcript read begun before Start over does not bring the old turns back', () => {
    const store = createCometThreads('bot-1')
    const turns: ChatTurnDto[] = [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }]
    store.load('bot-1', turns)
    const captured = store.thread('bot-1').doneSeen
    store.fresh('bot-1')
    store.load('bot-1', turns, captured)
    expect(store.thread('bot-1').messages).toEqual([])
    expect(store.thread('bot-1').loaded).toBe(true)
  })
})
