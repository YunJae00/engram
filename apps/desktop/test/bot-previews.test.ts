import { expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appendBotTurn, archiveBotTranscript, createBot, initVault } from 'core'
import { botPreviews, botSearch } from '../src/main/bot-previews.js'

it('previews existing conversations, refreshes changed transcripts, and clears archived messages without changing bots', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  const bot = await createBot(paths, { name: 'Research' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBeUndefined()
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'The review\n is ready.', at: '2026-01-02T10:00:00Z' })
  const first = (await botPreviews(paths, [bot]))[0]?.lastMessage
  expect(first).toEqual({ role: 'assistant', text: 'The review is ready.', at: '2026-01-02T10:00:00Z' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBe(first)
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'Please revise the conclusion.', at: '2026-01-02T10:01:00Z' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage?.text).toBe('Please revise the conclusion.')
  await archiveBotTranscript(paths, bot.id)
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBeUndefined()
  expect(bot).not.toHaveProperty('lastMessage')
})

it('finds conversations by any message text, caches by file stamp, and ignores progress and archived turns', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  const at = '2026-01-02T10:00:00Z'
  const a = await createBot(paths, { name: 'Weekly sync' })
  const long = `T${'x'.repeat(250)}`
  for (const [role, text] of [['user', `회의코드 QX-7731 준비 ${long}`], ['assistant', 'Agenda for QX-7731 drafted'], ['user', 'Add budget'], ['assistant', 'Updated the 견적서']] as const) await appendBotTurn(paths, a.id, { role, text, at })
  const b = await createBot(paths, { name: 'Budget' })
  await appendBotTurn(paths, b.id, { role: 'user', text: 'QX-7730 only', at })
  await appendBotTurn(paths, b.id, { role: 'assistant', text: 'checking QX-7731', at, progress: true })
  const file = join(paths.cache, 'bot-chats', `${a.id}.jsonl`)
  await utimes(file, 1_700_000_000, 1_700_000_000)
  for (const query of ['QX-7731', 'qx-7731', '회의코드', '  qx-7731 ', long, long.slice(0, 201)]) expect(await botSearch(paths, [a, b], query)).toEqual([a.id])
  expect(await botSearch(paths, [a, b], '')).toEqual([])
  expect(await botSearch(paths, [a, b], 'Add budget\nUpdated')).toEqual([])
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('QX-7731', 'QX-9999'))
  await utimes(file, 1_700_000_000, 1_700_000_000)
  expect(await botSearch(paths, [a], 'QX-9999')).toEqual([])
  await appendFile(file, '\n')
  expect(await botSearch(paths, [a], 'QX-9999')).toEqual([a.id])
  const c = await createBot(paths, { name: 'Long' })
  for (let index = 0; index < 401; index++) await appendBotTurn(paths, c.id, { role: 'user', text: index === 0 ? 'first QX-5555' : `turn ${index}`, at })
  expect(await botSearch(paths, [a, b, c], 'qx-5555')).toEqual([c.id])
  await archiveBotTranscript(paths, a.id)
  expect(await botSearch(paths, [a], 'QX-9999')).toEqual([])
})
