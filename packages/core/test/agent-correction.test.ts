import { expect, it, vi } from 'vitest'
import { runComet } from '../src/agent-session.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

it('returns failed verification to the conversation without executing a correction pass', async () => {
  const runTools = vi.fn(async job => {
    await job.tools.find((tool: { name: string }) => tool.name === 'excel_write').run({ cells: [{ cell: 'A1', value: 1 }] })
    return { answer: 'The change could not be verified.' }
  })
  const engine = { id: 'mock', desktopToolIsolation: true, runTools } as unknown as Engine
  const result = await runComet({ engine, workdir: 'tmp' as EngineCwd, tools: [{ name: 'excel_write', description: 'write', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'B.xlsx', sheet: 'S', written: ['A1'], verification: 'not verified' }) }] }, 'Update A1', { guided: false })
  expect(runTools).toHaveBeenCalledOnce()
  expect(result.steps).toHaveLength(1)
  expect(result.incomplete).toBeTruthy()
})
