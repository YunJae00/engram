import { expect, it, vi } from 'vitest'
import { habitResult } from '../src/main/habit-drafts.js'
import type { Engine, EngineJobInput } from 'core'

const collect = vi.hoisted(() => vi.fn())
vi.mock('core', () => ({ collectResult: collect }))
const engine = { id: 'codex' } as Engine
const job = { prompt: 'Draft a how-to', disallowTools: false } as EngineJobInput

it('retries one interrupted draft stream with tools disabled', async () => {
  collect.mockReset().mockRejectedValueOnce(new Error('stream disconnected before completion')).mockResolvedValueOnce('draft')
  expect(await habitResult(engine, job)).toBe('draft')
  expect(collect).toHaveBeenCalledTimes(2)
  expect(collect.mock.calls.every(call => call[1].disallowTools === true)).toBe(true)
})

it('does not retry authentication, quota, or repeated stream errors', async () => {
  for (const message of ['Not logged in', 'Usage limit reached', 'stream disconnected before completion']) {
    collect.mockReset().mockRejectedValue(new Error(message))
    await expect(habitResult(engine, job)).rejects.toThrow(message)
    expect(collect).toHaveBeenCalledTimes(message.startsWith('stream') ? 2 : 1)
  }
})
