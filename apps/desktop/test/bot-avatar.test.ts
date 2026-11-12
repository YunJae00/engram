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

// Seeds a photo the way an old vault stored it, since new uploads are refused.
async function seedPhoto(paths: VaultPaths, id: string, data: Uint8Array, ext: 'png' | 'jpg') {
  await mkdir(join(paths.cache, 'bot-avatars'), { recursive: true })
  await writeFile(join(paths.cache, 'bot-avatars', `${id}.${ext}`), data)
  await updateBot(paths, id, { avatar: { image: `bot-avatars/${id}.${ext}` } })
}

it('refuses every new photo, even a valid one at the old 5 MB limit, with no write or broadcast', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const before = await botsJson(paths)
  const bad: unknown[] = [png(AVATAR_MAX_BYTES), png(AVATAR_MAX_BYTES + 1), jpeg(64), png(64), new Uint8Array(0), 'x']
  const set = setBotAvatarImage as (...args: unknown[]) => Promise<unknown>
  for (const data of bad) await expect(set(paths, bot.id, data, changed)).rejects.toThrow('no longer supported')
  for (const id of ['../evil', 'a/b', '..', '', 'nosuchbot']) await expect(set(paths, id, png(64), changed)).rejects.toThrow('no longer supported')
  expect(changed.calls).toBe(0)
  expect(await listing(paths)).toEqual([])
  expect((await botsJson(paths)).equals(before)).toBe(true)
})

it('legacy photo data reads safely by id and clears to the character', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  const sent = jpeg(100)
  sent[99] = 9
  await seedPhoto(paths, bot.id, sent, 'jpg')
  const read = await botAvatarImage(paths, bot.id)
  expect(read?.mime).toBe('image/jpeg')
  expect(Buffer.from(read!.data).equals(Buffer.from(sent))).toBe(true)

  const cleared = await clearBotAvatarImage(paths, bot.id, changed)
  expect(changed.calls).toBe(1)
  expect(Object.hasOwn(cleared, 'avatar')).toBe(false)
  expect(await listing(paths)).toEqual([])
  expect(await botAvatarImage(paths, bot.id)).toBeNull()

  const drawn = await createBot(paths, { name: 'Drawn' })
  const before = await botsJson(paths)
  await clearBotAvatarImage(paths, drawn.id, changed)
  expect((await botsJson(paths)).equals(before)).toBe(true)
  expect(changed.calls).toBe(1)
  expect((await avatarOf(paths, drawn.id))?.avatar).toEqual(drawn.avatar)

  const odd = await createBot(paths, { name: 'Odd' })
  await updateBot(paths, odd.id, { avatar: { image: '../x.png' } })
  await writeFile(join(paths.cache, 'x.png'), png(20))
  expect(await botAvatarImage(paths, odd.id)).toBeNull()
  for (const id of ['../evil', 'a/b', '', 42]) expect(await botAvatarImage(paths, id)).toBeNull()
  await expect(clearBotAvatarImage(paths, '../evil', changed)).rejects.toThrow('no such comet')
})

it('a failed clear keeps the legacy photo and its file', async () => {
  const paths = await vault()
  const bot = await createBot(paths, { name: 'Photo' })
  const changed = spy()
  await seedPhoto(paths, bot.id, png(64), 'png')
  const before = await botsJson(paths)
  fault.update = true
  await expect(clearBotAvatarImage(paths, bot.id, changed)).rejects.toThrow('disk full')
  expect((await botsJson(paths)).equals(before)).toBe(true)
  expect(await listing(paths)).toEqual([`${bot.id}.png`])
  expect(await temps(paths)).toEqual([])
  expect(changed.calls).toBe(0)
})

it('only an exact image avatar is read or cleared', async () => {
  const paths = await vault()
  const changed = spy()
  const extra = await createBot(paths, { name: 'Extra' })
  await seedPhoto(paths, extra.id, png(20), 'png')
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
  await seedPhoto(paths, bot.id, png(20), 'png')
  const target = join(paths.cache, 'bot-avatars', `${bot.id}.png`)
  const seen: boolean[] = []
  await clearBotAvatarImage(paths, bot.id, () => { seen.push(existsSync(target)) })
  expect(seen).toEqual([true])
  expect(existsSync(target)).toBe(false)
})
