import { expect, it, vi } from 'vitest'
import type { ToolSessionJob } from 'core'
const state = vi.hoisted(() => ({ decision: { available: true, reason: 'ready', model: 'jev-1.13.0' }, log: vi.fn() }))
vi.mock('../src/main/brain-connections.js', () => ({ decisionConnectionState: () => state.decision }))
vi.mock('../src/main/flog.js', () => ({ flog: state.log }))
import { logSessionTools } from '../src/main/session-diagnostics.js'

it('logs the actual session menu and a decision registration gap without prompt contents', () => {
  logSessionTools('codex', { tools: [{ name: 'page_steps' }], prompt: 'private prompt', system: 'private system' } as ToolSessionJob)
  const result = JSON.parse(state.log.mock.calls.at(-1)![1])
  expect(result).toMatchObject({ tools: ['page_steps'], decision: { available: true, model: 'jev-1.13.0' }, decisionMenu: 'configured-but-not-offered' })
  expect(JSON.stringify(result)).not.toContain('private')
})
