import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBot, initVault, loadBots, type VaultPaths } from 'core'
import { updateBot } from 'core/src/bots'
const fault = vi.hoisted(() => ({ update: false }))
vi.mock('core/src/bots', async (orig) => {
  const real = await orig<typeof import('core/src/bots')>()
  return {
    ...real,
    updateBot: vi.fn((...args: Parameters<typeof real.updateBot>) =>
      fault.update ? Promise.reject(new Error('disk full')) : real.updateBot(...args)),
  }
})
afterEach(() => { fault.update = false })
import { AVATAR_MAX_BYTES, botAvatarImage, clearBotAvatarImage, setBotAvatarImage } from '../src/main/bot-avatar.js'

async function vault() {
  await mkdir(resolve('tmp'), { recursive: true })
  return initVault(await mkdtemp(resolve('tmp/bot-avatar-')), { git: false })
}

function image(magic: number[], n: number) {
  const data = new Uint8Array(n)
  data.set(magic)
  return data
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (n: number) => image(PNG, n)
const jpeg = (n: number) => image([0xff, 0xd8, 0xff], n)
const botsJson = (paths: VaultPaths) => readFile(join(paths.cache, 'bots.json'))
const listing = (paths: VaultPaths) => readdir(join(paths.cache, 'bot-avatars')).catch(() => [] as string[])
const temps = async (paths: VaultPaths) => (await listing(paths)).filter(n => n.endsWith('.tmp'))
const avatarOf = async (paths: VaultPaths, id: string) => (await loadBots(paths)).find(b => b.id === id)

function spy() {
  const fn = () => { fn.calls++ }
  fn.calls = 0
  return fn
}

it('rejects >5MB and non-image bytes', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const before = await botsJson(paths)
  const ascii = (s: string, n: number) => image([...new TextEncoder().encode(s)], n)
  const bad: unknown[] = [
    png(AVATAR_MAX_BYTES + 1),
    ascii('GIF89a', 64),
    new TextEncoder().encode('hello'),
    ascii('RIFF\0\0\0\0WEBP', 64),
    new Uint8Array(0),
    [...PNG, 0, 0, 0, 0],
  ]
  for (const data of bad) await expect(setBotAvatarImage(paths, bot.id, data, changed)).rejects.toThrow()
  expect(changed.calls).toBe(0)
  expect(await listing(paths)).toEqual([])
  expect((await botsJson(paths)).equals(before)).toBe(true)
  await setBotAvatarImage(paths, bot.id, png(AVATAR_MAX_BYTES), changed)
  expect(changed.calls).toBe(1)
  expect(await listing(paths)).toEqual([`${bot.id}.png`])
})

it('stores under .engram/bot-avatars by id, not filename', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const before = await botsJson(paths)
  for (const id of ['../evil', 'a/b', '..', '', 'nosuchbot']) {
    await expect(setBotAvatarImage(paths, id, png(64), changed)).rejects.toThrow('no such comet')
  }
  expect(await listing(paths)).toEqual([])
  expect((await botsJson(paths)).equals(before)).toBe(true)
  expect(changed.calls).toBe(0)

  const first = png(64)
  first[40] = 7
  await setBotAvatarImage(paths, bot.id, first, changed)
  expect(await listing(paths)).toEqual([`${bot.id}.png`])
  expect((await readFile(join(paths.cache, 'bot-avatars', `${bot.id}.png`))).equals(Buffer.from(first))).toBe(true)
  expect((await avatarOf(paths, bot.id))?.avatar).toEqual({ image: `bot-avatars/${bot.id}.png` })
  expect(changed.calls).toBe(1)

  const second = jpeg(64)
  const saved = await setBotAvatarImage(paths, bot.id, second, changed)
  expect(saved.avatar).toEqual({ image: `bot-avatars/${bot.id}.jpg` })
  expect(await listing(paths)).toEqual([`${bot.id}.jpg`])
  expect((await readFile(join(paths.cache, 'bot-avatars', `${bot.id}.jpg`))).equals(Buffer.from(second))).toBe(true)
  expect((await avatarOf(paths, bot.id))?.avatar).toEqual({ image: `bot-avatars/${bot.id}.jpg` })
  expect(changed.calls).toBe(2)
})

it('clear reverts to the character; image read derives the path from the id', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const sent = jpeg(100)
  sent[99] = 9
  await setBotAvatarImage(paths, bot.id, sent, changed)
  const read = await botAvatarImage(paths, bot.id)
  expect(read?.mime).toBe('image/jpeg')
  expect(Buffer.from(read!.data).equals(Buffer.from(sent))).toBe(true)
  await setBotAvatarImage(paths, bot.id, png(30), changed)
  expect((await botAvatarImage(paths, bot.id))?.mime).toBe('image/png')

  const calls = changed.calls
  const cleared = await clearBotAvatarImage(paths, bot.id, changed)
  expect(changed.calls).toBe(calls + 1)
  expect(Object.hasOwn(cleared, 'avatar')).toBe(false)
  expect(Object.hasOwn((await avatarOf(paths, bot.id))!, 'avatar')).toBe(false)
  expect(await listing(paths)).toEqual([])
  expect(await botAvatarImage(paths, bot.id)).toBeNull()

  const drawn = await createBot(paths, { name: 'Drawn' })
  const character = { body: 1, face: 1, accessory: 1, palette: 1 }
  await updateBot(paths, drawn.id, { avatar: character })
  const before = await botsJson(paths)
  await clearBotAvatarImage(paths, drawn.id, changed)
  expect((await botsJson(paths)).equals(before)).toBe(true)
  expect(changed.calls).toBe(calls + 1)
  expect((await avatarOf(paths, drawn.id))?.avatar).toEqual(character)

  const odd = await createBot(paths, { name: 'Odd' })
  await updateBot(paths, odd.id, { avatar: { image: '../x.png' } })
  await writeFile(join(paths.cache, 'x.png'), png(20))
  expect(await botAvatarImage(paths, odd.id)).toBeNull()
  expect(await botAvatarImage(paths, '../evil')).toBeNull()

})

it('a failed write keeps the previous photo', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const old = png(64)
  old[50] = 1
  await setBotAvatarImage(paths, bot.id, old, changed)
  const before = await botsJson(paths)
  fault.update = true
  for (const data of [png(80), jpeg(80)]) {
    await expect(setBotAvatarImage(paths, bot.id, data, changed)).rejects.toThrow('disk full')
    expect(await listing(paths)).toEqual([`${bot.id}.png`])
    expect((await readFile(join(paths.cache, 'bot-avatars', `${bot.id}.png`))).equals(Buffer.from(old))).toBe(true)
    expect((await botsJson(paths)).equals(before)).toBe(true)
    expect(await temps(paths)).toEqual([])
    expect(changed.calls).toBe(1)
  }
  fault.update = false

  await setBotAvatarImage(paths, bot.id, jpeg(40), changed)
  const prev = (await avatarOf(paths, bot.id))?.avatar
  const calls = changed.calls
  await mkdir(join(paths.cache, 'bot-avatars', `${bot.id}.png`, 'x'), { recursive: true })
  await expect(setBotAvatarImage(paths, bot.id, png(64), changed)).rejects.toThrow()
  expect((await avatarOf(paths, bot.id))?.avatar).toEqual(prev)
  expect(await temps(paths)).toEqual([])
  expect(changed.calls).toBe(calls)
})

it('only an exact image avatar is read or cleared', async () => {
  const paths = await vault()
  const changed = spy()
  const extra = await createBot(paths, { name: 'Extra' })
  await setBotAvatarImage(paths, extra.id, png(20), changed)
  const file = join(paths.cache, 'bots.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  raw.bots.find((b: { id: string }) => b.id === extra.id).avatar.extra = 1
  await writeFile(file, JSON.stringify(raw))
  const edited = await botsJson(paths)
  expect(await botAvatarImage(paths, extra.id)).toBeNull()
  const count = changed.calls
  await clearBotAvatarImage(paths, extra.id, changed)
  expect((await botsJson(paths)).equals(edited)).toBe(true)
  expect(changed.calls).toBe(count)

  const bot = await createBot(paths, { name: 'Photo' })
  await setBotAvatarImage(paths, bot.id, png(20), changed)
  const target = join(paths.cache, 'bot-avatars', `${bot.id}.png`)
  const seen: boolean[] = []
  await clearBotAvatarImage(paths, bot.id, () => { seen.push(existsSync(target)) })
  expect(seen).toEqual([true])
  expect(existsSync(target)).toBe(false)
})
