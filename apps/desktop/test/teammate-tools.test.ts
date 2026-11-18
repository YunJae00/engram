import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createBot, initVault, loadBots } from 'core'
import { expect, it } from 'vitest'
import { teammateSettingsTool } from '../src/main/teammate-tools.js'

it('changes a teammate\'s instructions and notifications from chat, for itself or a named teammate, and nothing else', async () => {
  const dir = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(dir, { recursive: true })
  const paths = await initVault(await mkdtemp(join(dir, 'teammate-tools-')), { git: false })
  const me = await createBot(paths, { name: '지민', purpose: '주간 보고서를 써요.' }), other = await createBot(paths, { name: '서연' })
  let changed = 0
  const tool = teammateSettingsTool(paths, me.id, () => { changed += 1 })
  const bot = async (id: string) => (await loadBots(paths)).find(one => one.id === id)!

  expect(JSON.parse(await tool.run({ instructions: '주간 보고서를 금요일 정오까지 써요.', notify: 'off' }, {} as never) as string)).toEqual({ teammate: '지민', instructions: '주간 보고서를 금요일 정오까지 써요.', notify: 'off' })
  expect(await bot(me.id)).toMatchObject({ name: '지민', purpose: '주간 보고서를 금요일 정오까지 써요.', notify: 'off' })
  expect((await bot(other.id)).notify).toBeUndefined()

  await tool.run({ who: '서연', notify: 'attention' }, {} as never)
  expect(await bot(other.id)).toMatchObject({ name: '서연', notify: 'attention' })
  expect((await bot(me.id)).purpose).toBe('주간 보고서를 금요일 정오까지 써요.')
  expect(changed).toBe(2)

  await expect(tool.run({ who: '도윤', notify: 'off' }, {} as never)).rejects.toThrow(/No teammate/)
  await expect(tool.run({}, {} as never)).rejects.toThrow(/instructions, notify/)
  await expect(tool.run({ notify: 'loud' }, {} as never)).rejects.toThrow(/notify must be/)
  expect(changed).toBe(2)
})
