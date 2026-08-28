import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addBotTask, createBot, loadBots, type VaultPaths } from 'core'
import { standingTick } from '../src/main/standing.js'

async function tempPaths(): Promise<VaultPaths> {
  const root = await mkdtemp(join(tmpdir(), 'engram-standing-'))
  return { root, workspace: root, cache: join(root, '.engram') } as unknown as VaultPaths
}

// A standing task starts through the routine door when it is due, once a
// day, and a refusal for the day counts as done.
describe('standingTick', () => {
  it('starts a due task once and leaves the rest alone', async () => {
    const paths = await tempPaths()
    const bot = await createBot(paths, { name: 'Desk', purpose: 'chores' })
    const due = await addBotTask(paths, bot.id, { name: 'Notice', goal: '포털 공지 확인', routineId: 'rt-1', schedule: { days: [1, 2, 3, 4, 5], hour: 9, minute: 0 } })
    await addBotTask(paths, bot.id, { name: 'Later', goal: 'x', routineId: 'rt-2', schedule: { days: [1, 2, 3, 4, 5], hour: 15, minute: 0 } })
    await addBotTask(paths, bot.id, { name: 'Plain', goal: 'y' })
    const ran: string[] = []
    const now = () => new Date(2026, 7, 25, 9, 10)
    const deps = { paths, runRoutine: async (id: string) => (ran.push(id), { ok: true }), now }
    expect(await standingTick(deps)).toEqual([due.id])
    expect(ran).toEqual(['rt-1'])
    expect(await standingTick(deps)).toEqual([])
    expect(ran).toEqual(['rt-1'])
    const task = (await loadBots(paths))[0]?.tasks?.find((t) => t.id === due.id)
    expect(task?.lastRunAt).toBe(now().toISOString())
  })

  it('a moment of trouble is tried again; a refusal for the day is not', async () => {
    const paths = await tempPaths()
    const bot = await createBot(paths, { name: 'Desk', purpose: 'chores' })
    await addBotTask(paths, bot.id, { name: 'Notice', goal: 'x', routineId: 'rt-1', schedule: { days: [1, 2, 3, 4, 5], hour: 9, minute: 0 } })
    const now = () => new Date(2026, 7, 25, 9, 10)
    let calls = 0
    const busy = { paths, runRoutine: async () => (calls++, { ok: false }), now }
    await standingTick(busy)
    await standingTick(busy)
    expect(calls).toBe(2)
    const refused = { paths, runRoutine: async () => (calls++, { ok: false, blocked: true }), now }
    await standingTick(refused)
    await standingTick(refused)
    expect(calls).toBe(3)
  })
})
