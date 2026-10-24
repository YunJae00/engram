import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { addBotTask, createBot, loadBots, type VaultPaths } from 'core'
import { standingTick } from '../src/main/standing.js'

async function tempPaths(): Promise<VaultPaths> {
  const dir = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(dir, { recursive: true })
  const root = await mkdtemp(join(dir, 'engram-standing-'))
  return { root, workspace: root, cache: join(root, '.engram') } as unknown as VaultPaths
}

// A standing task starts through the routine door when it is due, once a
// day, and a refusal for the day counts as done.
describe('standingTick', () => {
  it('starts a due task once and leaves the rest alone', async () => {
    const paths = await tempPaths()
    const bot = await createBot(paths, { name: 'Desk', purpose: 'chores' })
    const due = await addBotTask(paths, bot.id, { name: 'Notice', goal: 'Check portal notices', routineId: 'rt-1', schedule: { days: [1, 2, 3, 4, 5], hour: 9, minute: 0 } })
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

  it('starts a kept request by its name when due, waits while it cannot start, and lets a one-day one go once said or missed', async () => {
    const paths = await tempPaths()
    const bot = await createBot(paths, { name: 'Desk', purpose: 'chores' })
    const daily = await addBotTask(paths, bot.id, { name: 'Mail', goal: 'Sum up my mail', schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 5 } })
    await addBotTask(paths, bot.id, { name: 'Call', goal: 'Remind me to call', schedule: { days: [], hour: 9, minute: 0, on: '2026-08-25' } })
    await addBotTask(paths, bot.id, { name: 'Gone', goal: 'Old one', schedule: { days: [], hour: 8, minute: 0, on: '2026-08-20' } })
    const said: string[] = []
    let busy = true
    const now = () => new Date(2026, 7, 25, 9, 10)
    const deps = { paths, runRoutine: async () => ({ ok: true }), runPrompt: async (name: string, goal: string) => busy ? { ok: false } : (said.push(`${name}:${goal}`), { ok: true }), now }
    expect(await standingTick(deps)).toEqual([])
    expect((await loadBots(paths))[0]?.tasks?.map((t) => t.name)).toEqual(['Mail', 'Call'])
    busy = false
    expect(await standingTick(deps)).toEqual([daily.id])
    await standingTick(deps)
    expect(said).toEqual(['Mail:Sum up my mail', 'Call:Remind me to call'])
    expect((await loadBots(paths))[0]?.tasks?.map((t) => t.name)).toEqual(['Mail'])
    expect(await standingTick(deps)).toEqual([])
  })

  it('a watched request runs only when its listing shows something new, with just the count and ids, in one conversation', async () => {
    const paths = await tempPaths()
    const bot = await createBot(paths, { name: 'Desk', purpose: 'chores' })
    const task = await addBotTask(paths, bot.id, { name: 'Mail', goal: 'Sort new mail', schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0, every: 15 }, watch: { tool: 'outlook_mail', args: {} } })
    let listing: { key: string; id?: string }[] | null = [{ key: 'a', id: 'a' }]
    let clock = new Date(2026, 7, 25, 9, 0)
    const said: { goal: string; into?: string }[] = []
    const deps = {
      paths, now: () => clock, runRoutine: async () => ({ ok: true }), peek: async () => listing,
      runPrompt: async (_name: string, goal: string, into?: string) => (said.push({ goal, ...(into ? { into } : {}) }), { ok: true, botId: 'chat-1' }),
    }
    expect(await standingTick(deps)).toEqual([task.id])
    clock = new Date(2026, 7, 25, 9, 15)
    expect(await standingTick(deps)).toEqual([])
    listing = null
    clock = new Date(2026, 7, 25, 9, 30)
    expect(await standingTick(deps)).toEqual([])
    listing = [{ key: 'b', id: 'b' }, { key: 'a', id: 'a' }, { key: 'c9f' }]
    expect(await standingTick(deps)).toEqual([task.id])
    expect(said).toEqual([
      { goal: 'Sort new mail\n\n(1 new in outlook_mail since the last look; ids: a)' },
      { goal: 'Sort new mail\n\n(2 new in outlook_mail since the last look; ids: b)', into: 'chat-1' },
    ])
    expect((await loadBots(paths))[0]?.tasks?.[0]).toMatchObject({ seen: ['b', 'a', 'c9f'], chat: 'chat-1' })
  })
})
