import { describe, expect, it } from 'vitest'
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resetBotsToV2 } from '../src/bots-reset.js'
import { addNotice, readNotices } from '../src/notices.js'
import { renameWithRetry } from '../src/rename-with-retry.js'
import type { VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-11-10T08:30:15.123Z')
const BASE = 'bots-v1-2026-11-10T08-30-15'
const ID = /^bot-[0-9a-z]+-[0-9a-f]{1,4}$/
const TEXT = (folder: string) => `이전 대화는 백업 폴더에 있어요 (.engram/backups/${folder})`

async function vault(name: string): Promise<VaultPaths> {
  const cache = join(await tmpVaultRoot(`bots-reset-${name}`), '.engram')
  await mkdir(cache, { recursive: true })
  return { cache } as VaultPaths
}

async function put(paths: VaultPaths, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(join(paths.cache, rel, '..'), { recursive: true })
    await writeFile(join(paths.cache, rel), data)
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

async function listing(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of (await readdir(dir)).sort()) {
    const info = await stat(join(dir, name))
    out.push(`${prefix}${name} ${info.size} ${info.mtimeMs}`)
    if (info.isDirectory()) out.push(...await listing(join(dir, name), `${prefix}${name}/`))
  }
  return out
}

async function folders(paths: VaultPaths): Promise<string[]> {
  return (await readdir(join(paths.cache, 'backups')).catch(() => [] as string[])).filter(name => name.startsWith('bots-v1-'))
}

async function expectV2(paths: VaultPaths, createdAt = NOW.toISOString()): Promise<void> {
  const list = JSON.parse(await readFile(join(paths.cache, 'bots.json'), 'utf8')) as { bots: { id: string }[] }
  expect(list).toEqual({ version: 2, bots: [{ id: expect.stringMatching(ID), name: 'Engram', purpose: '', createdAt, updatedAt: createdAt, primary: true }], dismissed: [] })
}

async function expectBackedUp(paths: VaultPaths, folder: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, data] of Object.entries(files)) {
    expect(await readFile(join(paths.cache, 'backups', folder, rel))).toEqual(Buffer.from(data))
    if (rel !== 'bots.json') expect(await exists(join(paths.cache, rel))).toBe(false)
  }
  expect(await exists(join(paths.cache, 'backups', folder, '.reset-incomplete'))).toBe(false)
}

const task = (schedule?: object, paused = false) => ({ id: 't', prompt: 'p', ...(schedule ? { schedule } : {}), ...(paused ? { paused } : {}) })
const V1 = {
  'bots.json': JSON.stringify({ bots: [{ id: 'a', name: 'A', tasks: [task({ every: 'day' }), task({ every: 'week' }, true), task()] }, { id: 'b', name: 'B' }] }),
  'bot-chats/a.jsonl': '{"role":"user","text":"hi"}\n',
  'bot-chats/b.jsonl': '{"role":"user","text":"yo"}\n',
  'bot-chats/a.2026-01-01T00-00-00.jsonl': '{"role":"user","text":"old"}\n',
  'bot-memory/a.json': '{"facts":["x"]}',
  'bot-memory/b.json': '{"facts":["y"]}',
}
const PERSON = { 'bot-memory/_person.json': '{"name":"me"}' }
const OTHERS = { 'sidebar-layout.json': '{"order":[]}', 'checkpoints/x': 'cp', 'chat-attachments/x': 'att' }

describe('resetBotsToV2', () => {
  it('v1 files moved to backup byte-identical, _person stays', async () => {
    const paths = await vault('move')
    await put(paths, { ...V1, ...PERSON, ...OTHERS })
    await resetBotsToV2(paths, { now: NOW })
    expect(await folders(paths)).toEqual([BASE])
    await expectBackedUp(paths, BASE, V1)
    expect(await readFile(join(paths.cache, 'bot-memory/_person.json'), 'utf8')).toBe(PERSON['bot-memory/_person.json'])
    expect(await exists(join(paths.cache, 'backups', BASE, 'bot-memory/_person.json'))).toBe(false)
    for (const [rel, data] of Object.entries(OTHERS)) expect(await readFile(join(paths.cache, rel), 'utf8')).toBe(data)
    await expectV2(paths)
  })

  it('second run touches nothing; interrupted reset resumes without loss', async () => {
    const steady = await vault('steady')
    await put(steady, { ...V1, 'bots.json': JSON.stringify({ version: 2, bots: [] }), 'bots.json.x.tmp': 'z' })
    const before = await listing(steady.cache)
    await resetBotsToV2(steady, { now: NOW })
    expect(await listing(steady.cache)).toEqual(before)

    const broken = await vault('interrupted')
    await put(broken, V1)
    const failing = async (from: string, to: string) => {
      if (from.includes('bot-memory')) throw new Error('locked')
      await renameWithRetry(from, to)
    }
    await expect(resetBotsToV2(broken, { now: NOW, rename: failing })).rejects.toThrow('locked')
    expect(await readFile(join(broken.cache, 'bots.json'), 'utf8')).toBe(V1['bots.json'])
    expect(await readFile(join(broken.cache, 'backups', BASE, 'bot-chats/a.jsonl'), 'utf8')).toBe(V1['bot-chats/a.jsonl'])
    expect(await exists(join(broken.cache, 'backups', BASE, '.reset-incomplete'))).toBe(true)
    expect(await readNotices(broken)).toEqual([])
    await resetBotsToV2(broken, { now: new Date('2026-11-11T00:00:00.000Z') })
    expect(await folders(broken)).toEqual([BASE])
    await expectBackedUp(broken, BASE, V1)
    expect(await readNotices(broken)).toHaveLength(1)
    await expectV2(broken, '2026-11-11T00:00:00.000Z')

    const corrupt = await vault('corrupt')
    const bad = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"bots":')])
    await put(corrupt, { 'bots.json': bad })
    await resetBotsToV2(corrupt, { now: NOW })
    await expectBackedUp(corrupt, BASE, { 'bots.json': bad })
    await expectV2(corrupt)

    const occupied = await vault('occupied')
    await put(occupied, { ...V1, [`backups/${BASE}/.reset-incomplete`]: '', [`backups/${BASE}/bot-chats/a.jsonl`]: 'kept' })
    await expect(resetBotsToV2(occupied, { now: NOW })).rejects.toThrow('already exists')
    expect(await readFile(join(occupied.cache, 'backups', BASE, 'bot-chats/a.jsonl'), 'utf8')).toBe('kept')
    expect(await readFile(join(occupied.cache, 'bot-chats/a.jsonl'), 'utf8')).toBe(V1['bot-chats/a.jsonl'])

    const afterMarker = await vault('after-marker')
    await put(afterMarker, { [`backups/${BASE}/bots.json`]: V1['bots.json'] })
    await resetBotsToV2(afterMarker, { now: new Date('2026-11-12T00:00:00.000Z') })
    expect(await folders(afterMarker)).toEqual([BASE])
    expect(await readNotices(afterMarker)).toEqual([])
    await expectV2(afterMarker, '2026-11-12T00:00:00.000Z')

    const dirList = await vault('dir-list')
    await put(dirList, { 'bots.json/inner': 'x' })
    await resetBotsToV2(dirList, { now: NOW })
    expect(await readFile(join(dirList.cache, 'backups', BASE, 'bots.json/inner'), 'utf8')).toBe('x')
    await expectV2(dirList)
  })

  it('notice counts stopped schedules; corrupt v1 omits count', async () => {
    const counted = await vault('counted')
    await put(counted, V1)
    await resetBotsToV2(counted, { now: NOW })
    const items = await readNotices(counted)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'system', key: `bots-reset:${BASE}`, text: `${TEXT(BASE)} 일정 2개가 멈췄어요` })
    expect(items[0]?.title.length).toBeGreaterThan(0)

    const none = await vault('no-schedules')
    await put(none, { 'bots.json': JSON.stringify({ bots: [{ id: 'a', tasks: [task(), { schedule: [] }, null] }, null] }) })
    await resetBotsToV2(none, { now: NOW })
    expect((await readNotices(none)).map(item => item.text)).toEqual([TEXT(BASE)])

    const corrupt = await vault('corrupt-count')
    await put(corrupt, { 'bots.json': '{"bots":[' })
    await resetBotsToV2(corrupt, { now: NOW })
    expect((await readNotices(corrupt)).map(item => item.text)).toEqual([TEXT(BASE)])

    const resumed = await vault('resumed')
    await put(resumed, V1)
    await resetBotsToV2(resumed, { now: NOW })
    const first = await readNotices(resumed)
    await writeFile(join(resumed.cache, 'backups', BASE, '.reset-incomplete'), '')
    await rm(join(resumed.cache, 'bots.json'))
    await resetBotsToV2(resumed, { now: NOW })
    expect(await readNotices(resumed)).toEqual(first)
    expect(await readFile(join(resumed.cache, 'backups', BASE, 'bots.json'), 'utf8')).toBe(V1['bots.json'])
  })

  it('nothing to back up writes only the new list', async () => {
    for (const seed of [{}, { ...PERSON, 'bot-chats': null }]) {
      const paths = await vault('empty')
      if ('bot-chats' in seed) {
        await put(paths, PERSON)
        await mkdir(join(paths.cache, 'bot-chats'))
      }
      await resetBotsToV2(paths, { now: NOW })
      expect(await exists(join(paths.cache, 'backups'))).toBe(false)
      expect(await readNotices(paths)).toEqual([])
      await expectV2(paths)
      const before = await listing(paths.cache)
      await resetBotsToV2(paths)
      expect(await listing(paths.cache)).toEqual(before)
    }
    const blocked = await vault('backups-file')
    await put(blocked, { backups: 'occupied' })
    await expect(resetBotsToV2(blocked, { now: NOW })).rejects.toThrow('not a directory')
    expect(await exists(join(blocked.cache, 'bots.json'))).toBe(false)
  })

  it('reset notice and concurrent addNotice calls all survive', async () => {
    const paths = await vault('concurrent')
    await put(paths, { ...V1, 'notices.json.tmp': 'n' })
    const keys = [`bots-reset:${BASE}`]
    const others: Promise<unknown>[] = []
    const other = (key: string) => { keys.push(key); others.push(addNotice(paths, { kind: 'habit', title: key, text: key, key })) }
    other('h:before')
    const racing = async (from: string, to: string) => {
      other(`h:${keys.length}`)
      await renameWithRetry(from, to)
    }
    const reset = resetBotsToV2(paths, { now: NOW, rename: racing })
    other('h:after')
    await Promise.all([reset, ...others])
    expect(keys.length).toBe(9)
    expect((await readNotices(paths)).map(item => item.key).sort()).toEqual(keys.sort())
  })

  it('edge states: scratch, pre-epoch id, occupied and empty backup names', async () => {
    const leftovers = { [`bots.json.${process.pid}.tmp`]: Buffer.from([1, 2, 3]), 'bots.json.x.tmp': 'stale', 'notices.json.tmp': 'n' }
    for (const seed of [{}, V1]) {
      const paths = await vault('scratch')
      await put(paths, { ...seed, ...leftovers })
      await resetBotsToV2(paths, { now: NOW })
      for (const [rel, data] of Object.entries(leftovers)) expect(await readFile(join(paths.cache, rel))).toEqual(Buffer.from(data))
      expect((await readdir(paths.cache)).filter(name => /\.reset-|\.kept-/.test(name))).toEqual([])
      await expectV2(paths)
    }

    const old = await vault('pre-epoch')
    await resetBotsToV2(old, { now: new Date(-86400000) })
    await expectV2(old, '1969-12-31T00:00:00.000Z')

    const fileName = await vault('file-name')
    await put(fileName, { 'bots.json': V1['bots.json'], [`backups/${BASE}`]: 'not a folder' })
    await resetBotsToV2(fileName, { now: NOW })
    expect(await readFile(join(fileName.cache, 'backups', BASE), 'utf8')).toBe('not a folder')
    await expectBackedUp(fileName, `${BASE}-2`, { 'bots.json': V1['bots.json'] })
    await expectV2(fileName)

    const empty = await vault('empty-folder')
    await put(empty, V1)
    await mkdir(join(empty.cache, 'backups', BASE), { recursive: true })
    await resetBotsToV2(empty, { now: new Date('2026-11-11T00:00:00.000Z') })
    expect(await folders(empty)).toEqual([BASE])
    await expectBackedUp(empty, BASE, V1)
    expect(await readNotices(empty)).toHaveLength(1)
    await expectV2(empty, '2026-11-11T00:00:00.000Z')

    const unreadable = await vault('unreadable')
    await put(unreadable, { [`backups/${BASE}/.reset-incomplete`]: '', [`backups/${BASE}/bots.json`]: '{"bots":[{"tasks":[{"schedule":{}}]}]}' })
    await chmod(join(unreadable.cache, 'backups', BASE, 'bots.json'), 0)
    await resetBotsToV2(unreadable, { now: NOW })
    const text = (await readNotices(unreadable))[0]?.text
    // chmod 0 cannot block reads for root, nor on Windows (it only sets the read-only attribute)
    const stillReadable = process.getuid?.() === 0 || process.platform === 'win32'
    expect(stillReadable ? text?.startsWith(TEXT(BASE)) : text === TEXT(BASE)).toBe(true)
  })
})
