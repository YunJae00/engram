import { expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

it('stops at reported token usage even when the engine ignores cancellation', async () => {
  const engine = { runTools: (job: ToolSessionJob) => {
    job.onUsage?.(40)
    expect(job.signal?.aborted).toBe(false)
    job.onUsage?.(60)
    return new Promise(() => {})
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Work', { tokenBudget: 100 })
  expect(result.budgetExhausted).toBe(true)
  expect(result.tokensUsed).toBe(100)
})

it('exposes engine input delivery without waiting for an Engram tool call', async () => {
  const delivered: string[][] = []
  let receive: ((messages: string[]) => Promise<boolean>) | null = null
  const engine = { runTools: async (job: ToolSessionJob) => {
    job.onSteerable?.(async messages => { delivered.push(messages); return true })
    expect(await receive?.(['Only read'])).toBe(true)
    return { answer: 'Read only' }
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Inspect', { onSteerable: steer => { receive = steer } })
  expect(result.answer).toBe('Read only')
  expect(delivered).toEqual([['Only read']])
  expect(receive).toBeNull()
})
