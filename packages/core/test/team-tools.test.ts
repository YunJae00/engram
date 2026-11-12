import { expect, test, vi } from 'vitest'
import { pickTools } from '../src/agent-prompt.js'
import { addBotTask, createBot, loadBots } from '../src/bots.js'
import { teamTool } from '../src/team-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

async function team() {
  const paths = await initVault(await tmpVaultRoot('team-tools'), { git: false })
  const existing = await createBot(paths, { name: 'Grok' })
  await addBotTask(paths, existing.id, { name: 'mail', goal: 'Sum up my mail', schedule: { days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } })
  const before = (await loadBots(paths))[0]!.tasks
  const changed = vi.fn()
  const tool = teamTool(paths, changed, () => new Date(2026, 10, 12, 10, 0))
  return { paths, existing, before, changed, tool }
}

test('asking for a new bot creates one with its own daily schedule', async () => {
  const { paths, existing, before, changed, tool } = await team()
  const result = JSON.parse(await tool.run({ name: '서울 날씨', instructions: '매일 서울 날씨를 알려준다', what: '서울 날씨 알려줘', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, { task: '' }) as string)
  const bots = await loadBots(paths)
  expect(bots).toHaveLength(2)
  const made = bots.find(b => b.id !== existing.id)!
  expect(made.name).toBe('서울 날씨')
  expect(made.purpose).toBe('매일 서울 날씨를 알려준다')
  expect(made.tasks).toHaveLength(1)
  expect(made.tasks![0]!.schedule).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
  expect(made.tasks![0]!.goal).toBe('서울 날씨 알려줘')
  expect(bots.find(b => b.id === existing.id)!.tasks).toEqual(before)
  expect(result.created).toEqual({ id: made.id, name: '서울 날씨' })
  expect(result.scheduled.when).toBe('every day 09:00')
  expect(changed).toHaveBeenCalledTimes(1)
})

test('refuses an empty name, a bad time or a taken name and creates nothing', async () => {
  const { paths, before, changed, tool } = await team()
  await expect(tool.run({ name: '  ', instructions: 'x' }, { task: '' })).rejects.toThrow('name')
  await expect(tool.run({ name: 'A', instructions: 'x', time: '25:00', days: [1] }, { task: '' })).rejects.toThrow('HH:MM')
  await expect(tool.run({ name: 'Grok', instructions: 'x' }, { task: '' })).rejects.toThrow('already exists')
  const bots = await loadBots(paths)
  expect(bots).toHaveLength(1)
  expect(bots[0]!.tasks).toEqual(before)
  expect(changed).not.toHaveBeenCalled()
})

test('a new bot without a schedule has no tasks', async () => {
  const { paths, existing, tool } = await team()
  const result = JSON.parse(await tool.run({ name: 'Notes', instructions: 'keeps notes' }, { task: '' }) as string)
  const bots = await loadBots(paths)
  expect(bots).toHaveLength(2)
  expect(bots.find(b => b.id !== existing.id)!.tasks ?? []).toEqual([])
  expect(result.scheduled).toBeUndefined()
})

test('a guided bot is offered new_bot when asked for a new bot', () => {
  const tools = ['search_memory', 'read_note', 'find_procedure', 'open_skill', 'propose_note', 'search_web', 'schedule', 'new_bot']
    .map(name => ({ name, description: name, argsSchema: { type: 'object' }, run: async () => '' }))
  const menu = (task: string) => pickTools(tools, task, [], true).map(t => t.name)
  for (const task of ['새로운 봇 만들어줄 수 있어? 매일 오전 9시에 서울 날씨 알려줘', '날씨 알려주는 봇을 만들어줘', 'Can you make a new bot for the weather?'])
    expect(menu(task)).toContain('new_bot')
  for (const task of ['매일 오전 9시에 서울 날씨 알려줘', 'remind me tomorrow at 9'])
    expect(menu(task)).not.toContain('new_bot')
})
