import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addBotTask, createBot, markBotTaskRun, setBotTaskPaused } from '../src/bots.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

type Json = Record<string, unknown> & { id: string }

async function setup() {
  const paths = await initVault(await tmpVaultRoot('bot-task-pause'), { git: false })
  const bot = await createBot(paths, { name: 'Pauser' })
  const other = await createBot(paths, { name: 'Other' })
  const t1 = await addBotTask(paths, bot.id, { name: 'One', goal: 'x', schedule: { days: [1], hour: 9, minute: 0 } })
  const t2 = await addBotTask(paths, bot.id, { name: 'Two', goal: 'y' })
  await addBotTask(paths, other.id, { name: 'Three', goal: 'z' })
  await markBotTaskRun(paths, bot.id, t1.id, new Date('2026-01-09T17:00:00.000Z'))
  const file = join(paths.cache, 'bots.json')
  const raw = () => readFile(file, 'utf8')
  const parsed = async () => JSON.parse(await raw()) as { bots: (Json & { tasks: Json[] })[] }
  const taskOf = async (taskId: string) => (await parsed()).bots.find(b => b.id === bot.id)!.tasks.find(t => t.id === taskId)!
  return { paths, bot, t1, t2, raw, parsed, taskOf }
}

describe('setBotTaskPaused', () => {
  it('pause sets paused true, resume deletes it, nothing else changes', async () => {
    const { paths, bot, t1, t2, raw, parsed, taskOf } = await setup()
    const before = await parsed()
    const original = await taskOf(t1.id)
    expect(original.lastRunAt).toBe('2026-01-09T17:00:00.000Z')
    await setBotTaskPaused(paths, bot.id, t1.id, true)
    expect(await taskOf(t1.id)).toEqual({ ...original, paused: true })
    const expected = structuredClone(before)
    const tasks = expected.bots.find(b => b.id === bot.id)!.tasks
    tasks[tasks.findIndex(t => t.id === t1.id)] = { ...original, paused: true }
    expect(await parsed()).toEqual(expected)
    expect(Object.hasOwn(await taskOf(t2.id), 'paused')).toBe(false)
    const paused = await raw()
    await setBotTaskPaused(paths, bot.id, t1.id, true)
    expect(await raw()).toBe(paused)
    await setBotTaskPaused(paths, bot.id, t1.id, false)
    const resumed = await taskOf(t1.id)
    expect(Object.hasOwn(resumed, 'paused')).toBe(false)
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(original))
    expect(await parsed()).toEqual(before)
  })

  it('bad ids or a non-boolean paused write nothing', async () => {
    const { paths, bot, t1, raw } = await setup()
    const bytes = await raw()
    for (const [botId, taskId] of [['', t1.id], [bot.id, ''], ['nope', t1.id], [bot.id, 'nope']]) {
      await expect(setBotTaskPaused(paths, botId!, taskId!, true)).rejects.toThrow('no such task')
      expect(await raw()).toBe(bytes)
    }
    for (const bad of ['yes', 1, null, undefined]) {
      const call = () => setBotTaskPaused(paths, bot.id, t1.id, bad as unknown as boolean)
      await expect(call()).rejects.toThrow(TypeError)
      await expect(call()).rejects.toThrow('paused must be a boolean')
      expect(await raw()).toBe(bytes)
    }
  })
})
