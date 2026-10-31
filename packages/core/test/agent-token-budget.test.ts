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
