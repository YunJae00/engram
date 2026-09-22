import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { addRoutine, createBot, initVault, listRoutines, readRoutineLearning, type Engine, type EngineJobInput } from 'core'
import type { VaultContext } from '../src/main/vault.js'

const fixture = vi.hoisted(() => ({ engine: undefined as Engine | undefined, broadcast: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fixture.broadcast }))
vi.mock('../src/main/ai-selection.js', () => ({ chatEngine: async () => fixture.engine }))
import { registerRoutineLearning } from '../src/main/routine-learning.js'

beforeEach(() => { fixture.engine = undefined; fixture.broadcast.mockClear() })
async function setup() {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/routine-learning-host-')), { git: false })
  const bot = await createBot(paths, { name: 'Routine fixture' })
  let busy = false
  const host = registerRoutineLearning({ paths, engines: [] } as unknown as VaultContext, () => busy)
  return { paths, bot, host, working: (next: boolean) => { busy = next } }
}

it('requires explicit activation, organizes without tools, and saves only after review without scheduling', async () => {
  const { paths, bot, host } = await setup()
  expect(await host.active(bot.id)).toBeUndefined()
  await host.action(bot.id, 'start')
  const id = await host.active(bot.id)
  await host.record(bot.id, id, 'Read reports and verify totals', [{ tool: 'open_page', args: { url: 'https://example.com/reports' }, observation: 'Reports' }], true)
  let job: EngineJobInput | undefined
  fixture.engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), async *run(input) { job = input; yield { type: 'result', text: JSON.stringify({ name: 'Check reports', goal: 'Open reports, ask for the current period, and verify totals without submitting changes.', does: 'Check current report totals.' }) } } }
  const draft = (await host.action(bot.id, 'finish'))!
  expect(job?.disallowTools).toBe(true)
  expect(draft.preparing).toBe(false)
  expect(draft.phase).toBe('review')
  expect(await listRoutines(paths)).toEqual([])
  await host.action(bot.id, 'save', { id: draft.id, name: draft.draft.name, goal: draft.draft.goal })
  const saved = await listRoutines(paths)
  expect(saved).toHaveLength(1)
  expect(saved[0]?.task?.urls).toEqual(['https://example.com/reports'])
  expect(saved[0]?.lastRunAt).toBeUndefined()
  expect(await readRoutineLearning(paths, bot.id)).toBeNull()
  await expect(host.action(bot.id, 'save', { id: draft.id, name: 'Duplicate', goal: draft.draft.goal })).rejects.toThrow('Start the Routine skill')
})

it('blocks overlapping work and preserves a manually editable review when the provider is unavailable', async () => {
  const { paths, bot, host, working } = await setup()
  working(true)
  await expect(host.action(bot.id, 'start')).rejects.toThrow('Wait for this conversation')
  working(false)
  await host.action(bot.id, 'start')
  await host.record(bot.id, await host.active(bot.id), 'Check the current inventory', [], true)
  await expect(host.action(bot.id, 'finish')).rejects.toThrow('Connect an AI')
  const state = (await readRoutineLearning(paths, bot.id))!
  expect(state.phase).toBe('review')
  await expect(host.action(bot.id, 'save', { id: 'stale', name: 'Inventory', goal: 'Read inventory' })).rejects.toThrow('Review this draft')
  // A crash after writing the routine but before removing its draft cannot duplicate it.
  await addRoutine(paths, { id: `rt-${state.id}`, name: 'Inventory', steps: [], task: { goal: 'Read the current inventory and verify its date.', urls: [], method: [], surface: 'auto' } })
  await host.action(bot.id, 'save', { id: state.id, name: 'Inventory', goal: 'Read the current inventory and verify its date.' })
  expect(await listRoutines(paths)).toHaveLength(1)
})
