import { expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appendBotTurn, archiveBotTranscript, createBot, initVault, loadBots, readBotTranscript } from 'core'
import { botConversations, botPreviews, botSearch, botUpdate } from '../src/main/bot-previews.js'

const io = vi.hoisted(() => ({ opened: [] as string[], bytes: new Map<string, number>(), whole: [] as string[] }))

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof fs.open = async (path, ...rest) => {
    const handle = await fs.open(path, ...rest)
    const key = String(path)
    io.opened.push(key)
    const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>
    return Object.assign(handle, {
      read: async (...args: unknown[]) => {
        const result = await read(...args)
        io.bytes.set(key, (io.bytes.get(key) ?? 0) + result.bytesRead)
        return result
      },
    })
  }
  const readFile = ((path: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    io.whole.push(String(path))
    return (fs.readFile as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.readFile
  const createReadStream = (path: string, ...rest: unknown[]) => {
    io.whole.push(String(path))
    return (fs as unknown as { createReadStream: (...args: unknown[]) => unknown }).createReadStream(path, ...rest)
  }
  return { ...fs, default: { ...fs, open, readFile, createReadStream }, open, readFile, createReadStream }
})

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

it('list reads only the tail of live transcripts, never archives', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  const line = (index: number, extra: object = {}) => JSON.stringify({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index} 한글 🎉 ${'word '.repeat(index % 300)}`, at: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, ...extra })
  const expected = async (id: string) => {
    const turn = (await readBotTranscript(paths, id, Number.MAX_SAFE_INTEGER)).filter(turn => !turn.progress).at(-1)
    return turn ? { role: turn.role, text: turn.text.replace(/\s+/g, ' ').trim().slice(0, 200), at: turn.at } : undefined
  }
  const preview = async (raw: string) => {
    const bot = await createBot(paths, { name: 'Tail' })
    const live = join(dir, `${bot.id}.jsonl`)
    await writeFile(live, raw)
    io.opened.length = 0
    io.whole.length = 0
    io.bytes.clear()
    const lastMessage = (await botPreviews(paths, [bot]))[0]?.lastMessage
    expect(lastMessage).toEqual(await expected(bot.id))
    expect(io.bytes.get(live) ?? 0).toBeLessThanOrEqual(Buffer.byteLength(raw))
    return { bot, live, lastMessage }
  }

  const big = await createBot(paths, { name: 'Big' })
  const live = join(dir, `${big.id}.jsonl`)
  const raw = `${Array.from({ length: 2000 }, (_, index) => line(index)).join('\n')}\n`
  expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024)
  await writeFile(live, raw)
  for (let index = 0; index < 500; index++) {
    const stamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await writeFile(join(dir, `${big.id}.${stamp}.jsonl`), `${line(index)}\n`)
  }
  io.opened.length = 0
  io.whole.length = 0
  io.bytes.clear()
  const lastMessage = (await botPreviews(paths, [big]))[0]?.lastMessage
  expect(io.opened).toEqual([live])
  expect(io.bytes.get(live)).toBeLessThan(65536)
  expect(io.whole.filter(path => path.includes('bot-chats'))).toEqual([])
  expect(lastMessage).toEqual(await expected(big.id))
  expect(lastMessage?.text.startsWith('turn 1999')).toBe(true)

  const widened = await preview(`${Array.from({ length: 1000 }, (_, index) => line(index, index >= 700 ? { progress: true } : {})).join('\n')}\n`)
  expect(widened.lastMessage?.text.startsWith('turn 699')).toBe(true)
  expect(io.bytes.get(widened.live)).toBeGreaterThan(16384)
  expect((await preview(`${line(1)}\n${line(2)}\n{"role":"user","text":`)).lastMessage?.text.startsWith('turn 2')).toBe(true)
  expect((await preview(`${line(1)}\n${line(2)}`)).lastMessage?.text.startsWith('turn 2')).toBe(true)
  expect((await preview(`${line(1)}\n{"role":"user","text":null}\n[1]\nnull\n`)).lastMessage?.text.startsWith('turn 1')).toBe(true)
  expect((await preview('')).lastMessage).toBeUndefined()
  expect((await preview(`${Array.from({ length: 50 }, (_, index) => line(index, { progress: true })).join('\n')}\n`)).lastMessage).toBeUndefined()
})
