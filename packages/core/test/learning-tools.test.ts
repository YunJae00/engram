import { expect, it, vi } from 'vitest'
import { keepHowToTool, keepInMindTool, searchChatsTool } from '../src/learning-tools.js'

it('keeps up to three clean facts and refuses ones carrying a key', async () => {
  const keep = vi.fn(async () => undefined)
  const tool = keepInMindTool({ keep })
  expect(await tool.run({ facts: ['  Time Report is reached from PageOne - https://pageone.example/portal  ', 'b', 'c', 'd'] }, { task: '' })).toBe('Kept 3 for later conversations.')
  expect(keep).toHaveBeenCalledWith(['Time Report is reached from PageOne - https://pageone.example/portal', 'b', 'c'])
  await tool.run({ facts: ['The board is https://x.example/board?id=7&session=zzz&token=abcdefghijklmnopqrstuvwxyz0123456789'] }, { task: '' })
  expect(keep).toHaveBeenLastCalledWith(['The board is https://x.example/board?id=7'])
  await expect(tool.run({ facts: ['Use the key sk-abcdefghijklmnopqrstuvwxyz123456'] }, { task: '' })).rejects.toThrow('key')
  await expect(tool.run({ facts: [] }, { task: '' })).rejects.toThrow('one to three')
})

it('keeps a way as a how-to, and says when the person owns it or the library is full', async () => {
  const save = vi.fn(async () => ({ installed: true }))
  const tool = keepHowToTool({ save })
  const body = '## When to use\nLeave balance.\n## Steps\n1. Open PageOne, then Workday, then Time Off.'
  expect(await tool.run({ name: 'engram-leave-balance', description: 'Checking leave left', body }, { task: '' })).toContain('Kept as the how-to "leave-balance"')
  expect(save).toHaveBeenCalledWith('leave-balance', { title: 'leave-balance', description: 'Checking leave left', body })
  save.mockResolvedValueOnce({ installed: false, reason: 'user-owned' } as never)
  expect(await tool.run({ name: 'leave-balance', description: 'x', body }, { task: '' })).toContain('left as it is')
  save.mockResolvedValueOnce({ installed: false, reason: 'limit' } as never)
  expect(await tool.run({ name: 'leave-balance', description: 'x', body }, { task: '' })).toContain('full')
  await expect(tool.run({ name: 'x', description: '', body: 'short' }, { task: '' })).rejects.toThrow('description')
})

it('finds earlier conversations by their words, closest and newest first', async () => {
  const tool = searchChatsTool({
    chats: async () => [
      { name: 'Leave', turns: [{ role: 'user', text: 'workday 연차 확인', at: '2026-10-20T01:00:00Z' }, { role: 'assistant', text: 'PageOne → Workday → Time Off 에서 15일 남았어요', at: '2026-10-20T01:01:00Z' }] },
      { name: 'Dinner', turns: [{ role: 'user', text: '노량진 초장집 예약', at: '2026-10-25T01:00:00Z' }] },
    ],
  })
  const found = await tool.run({ query: 'Workday 연차' }, { task: '' })
  expect(found.split('\n')[1]).toContain('[Leave, 2026-10-20] They said: workday 연차 확인')
  expect(found).toContain('Time Off')
  expect(found).not.toContain('초장집')
  expect(await tool.run({ query: 'payroll' }, { task: '' })).toContain('No earlier conversation')
})
