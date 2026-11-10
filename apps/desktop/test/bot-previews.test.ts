import { expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appendBotTurn, archiveBotTranscript, createBot, initVault, loadBots } from 'core'
import { botConversations, botPreviews, botSearch, botUpdate } from '../src/main/bot-previews.js'

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

it('conversations lists archived transcripts newest first, live excluded', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  expect(await botConversations(paths, 'x')).toEqual([])
  const a = await createBot(paths, { name: 'Alpha' })
  const other = await createBot(paths, { name: 'Other' })
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  const turn = (role: string, extra: object = {}) => JSON.stringify({ role, text: 'hi', at: '2026-01-01T00:00:00Z', ...extra })
  await writeFile(join(dir, `${a.id}.jsonl`), `${turn('user')}\n`)
  await writeFile(join(dir, `${a.id}.2026-01-02T10-00-00.jsonl`), `${turn('user')}\n`)
  await writeFile(join(dir, `${a.id}.2026-03-04T05-06-07.jsonl`), [turn('user'), turn('assistant'), turn('assistant', { progress: true }), '{not json', '', ''].join('\n'))
  await writeFile(join(dir, `${other.id}.2026-05-05T00-00-00.jsonl`), `${turn('user')}\n`)
  await writeFile(join(dir, `${a.id}-2.2026-06-06T00-00-00.jsonl`), `${turn('user')}\n`)
  await mkdir(join(dir, `${a.id}.2026-02-02T00-00-00.jsonl`))
  expect(await botConversations(paths, a.id)).toEqual([{ stamp: '2026-03-04T05-06-07', turns: 2 }, { stamp: '2026-01-02T10-00-00', turns: 1 }])
  expect(await botConversations(paths, '../x')).toEqual([])
  expect(await botConversations(paths, 3)).toEqual([])
  await appendBotTurn(paths, other.id, { role: 'user', text: 'live', at: '2026-07-01T00:00:00Z' })
  await archiveBotTranscript(paths, other.id, new Date('2026-07-01T00:00:00.123Z'))
  expect((await botConversations(paths, other.id))[0]).toEqual({ stamp: '2026-07-01T00-00-00', turns: 1 })
})

it('update rejects invalid fields', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  const b = await createBot(paths, { name: 'Editable' })
  const file = join(paths.cache, 'bots.json')
  const before = await readFile(file)
  let calls = 0
  const changed = () => { calls++ }
  const bad: [unknown, unknown][] = [
    [b.id, { label: '😀'.repeat(41) }],
    [b.id, { notify: 'loud' }],
    [b.id, { avatar: { body: 6, face: 0, accessory: 0, palette: 0 } }],
    [b.id, { avatar: { body: 0, face: 0, accessory: 0, palette: 8 } }],
    [b.id, { createdAt: 'x' }],
    [b.id, { name: '  ' }],
    [b.id, 'nope'],
    ['missing-id', { label: 'x' }],
    [42, { label: 'x' }],
  ]
  for (const [id, patch] of bad) await expect(botUpdate(paths, id, patch, changed)).rejects.toThrow()
  expect((await readFile(file)).equals(before)).toBe(true)
  expect(calls).toBe(0)
  const fields = { label: '😀'.repeat(40), notify: 'off', avatar: { body: 0, face: 0, accessory: 0, palette: 0 } }
  const saved = await botUpdate(paths, b.id, fields, changed)
  expect(saved).toMatchObject(fields)
  expect(typeof saved.updatedAt).toBe('string')
  expect(calls).toBe(1)
  expect((await loadBots(paths)).find(x => x.id === b.id)).toMatchObject(fields)
  const long = await botUpdate(paths, b.id, { purpose: 'p'.repeat(2001) }, changed)
  expect(long.purpose).toHaveLength(2000)
  expect((await loadBots(paths)).find(x => x.id === b.id)?.purpose).toHaveLength(2000)
  expect(calls).toBe(2)
})
