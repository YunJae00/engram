import { expect, it, vi } from 'vitest'
import { CodexVoice } from '../src/main/engine-codex-voice.js'
import type { CodexRpcFactory } from '../src/main/codex-native.js'

it('accepts consecutive answers even when notifications precede the start response', async () => {
  let turns = 0
  const rpc: CodexRpcFactory = (_options, notify) => ({
    initialize: async () => {}, shutdown: async () => {},
    send: async method => {
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      const id = `turn-${++turns}`
      notify('item/completed', { threadId: 'thread', turnId: id, item: { type: 'agentMessage', text: id } })
      notify('turn/completed', { threadId: 'thread', turn: { id, status: 'completed' } })
      return { turn: { id } }
    },
  })
  const voice = new CodexVoice({ rpc, env: {}, config: [], cwd: '.' })
  try {
    expect(await voice.ask('first', 1000)).toBe('turn-1')
    expect(await voice.ask('second', 1000)).toBe('turn-2')
  } finally { voice.close() }
})

it('times out during initialization without starting a late turn', async () => {
  let open!: () => void
  const send = vi.fn(async () => ({ thread: { id: 'thread' } }))
  const rpc: CodexRpcFactory = () => ({ initialize: () => new Promise<void>(resolve => { open = resolve }), send, shutdown: async () => {} })
  const voice = new CodexVoice({ rpc, env: {}, config: [], cwd: '.' })
  await expect(voice.ask('hello', 10)).rejects.toThrow('too long')
  open()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(voice.closed).toBe(true)
  expect(send.mock.calls.map(call => call[0])).not.toContain('turn/start')
})
