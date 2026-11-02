import { expect, it, vi } from 'vitest'
import type { ToolSessionJob } from 'core'
vi.mock('electron', () => ({ app: { getPath: () => 'C:/home' } }))
import { runCodexNative, type CodexRpcFactory } from '../src/main/codex-native.js'

it('separates commentary from a final message even without an intervening tool', async () => {
  const events: string[] = []
  const rpc: CodexRpcFactory = (_options, notify) => ({
    initialize: async () => {}, shutdown: async () => {},
    send: async method => {
      if (method === 'thread/start') return { thread: { id: 'progress' } }
      if (method === 'turn/start') {
        setTimeout(() => {
          const emit = (method: string, data: Record<string, unknown>) => notify(method, { threadId: 'progress', turnId: 'turn', ...data })
          emit('item/started', { item: { id: 'one', type: 'agentMessage' } })
          emit('item/agentMessage/delta', { delta: 'Two records checked.' })
          emit('item/completed', { item: { id: 'one', type: 'agentMessage', text: 'Two records checked.' } })
          emit('item/started', { item: { id: 'two', type: 'agentMessage' } })
          emit('item/agentMessage/delta', { delta: 'The result is partial.' })
          emit('item/completed', { item: { id: 'two', type: 'agentMessage', text: 'The result is partial.' } })
          emit('turn/completed', { turn: { status: 'completed' } })
        }, 0)
        return { turn: { id: 'turn' } }
      }
      return {}
    },
  })
  const result = await runCodexNative({ workdir: 'C:/vault' as ToolSessionJob['workdir'], system: '', prompt: 'Read', tools: [], maxCalls: 5,
    native: { cwd: 'C:/work/progress', readRoots: [], decide: async () => ({ behavior: 'allow' }) },
    onToken: text => events.push(text), onReset: () => events.push('reset'),
  }, { rpc, env: {}, config: [], instructions: '' })
  expect(events).toEqual(['Two records checked.', 'reset', 'The result is partial.'])
  expect(result.answer).toBe('The result is partial.')
})
