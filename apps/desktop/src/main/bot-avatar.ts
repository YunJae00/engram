import { randomUUID } from 'node:crypto'
import { constants, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadBots, type Bot, type VaultPaths } from 'core'
import { updateBot } from 'core/src/bots'
import type { BotDto } from '../shared/types.js'

export const AVATAR_MAX_BYTES = 5_242_880
const BOT_ID = /^[\w-]+$/
const DIR = 'bot-avatars'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
type Ext = 'png' | 'jpg'
const MIME = { png: 'image/png', jpg: 'image/jpeg' } as const

const startsWith = (data: Uint8Array, magic: number[]) => magic.every((byte, i) => data[i] === byte)

function imageType(data: unknown): Ext {
  if (data instanceof Uint8Array && data.byteLength >= 1 && data.byteLength <= AVATAR_MAX_BYTES) {
    if (startsWith(data, PNG)) return 'png'
    if (startsWith(data, JPEG)) return 'jpg'
  }
  throw new Error('the photo must be a PNG or JPEG of at most 5 MB')
}

function stored(bot: Bot, id: string): Ext | undefined {
  const avatar = bot.avatar as unknown
  if (typeof avatar !== 'object' || avatar === null || Array.isArray(avatar)) return undefined
  const keys = Object.keys(avatar)
  if (keys.length !== 1 || keys[0] !== 'image') return undefined
  const image = (avatar as { image: unknown }).image
  return image === `${DIR}/${id}.png` ? 'png' : image === `${DIR}/${id}.jpg` ? 'jpg' : undefined
}

async function existing(paths: VaultPaths, id: unknown): Promise<(Bot & { id: string }) | undefined> {
  if (typeof id !== 'string' || !BOT_ID.test(id)) return undefined
  return (await loadBots(paths)).find(bot => bot.id === id)
}

async function drop(path: string): Promise<void> {
  try { await unlink(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const locks = new Map<string, Promise<unknown>>()

function locked<T>(paths: VaultPaths, id: unknown, work: () => Promise<T>): Promise<T> {
  const key = `${paths.cache}\n${String(id)}`
  const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.then(() => undefined, () => undefined)
  locks.set(key, settled)
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
  return next
}

export function setBotAvatarImage(paths: VaultPaths, id: unknown, data: unknown, changed: () => void): Promise<BotDto> {
  return locked(paths, id, async () => {
    const bot = await existing(paths, id)
    if (!bot) throw new Error('no such comet')
    const ext = imageType(data)
    const bytes = data as Uint8Array
    const previous = bot.avatar
    const dir = join(paths.cache, DIR)
    await mkdir(dir, { recursive: true })
    const prefix = `.${bot.id}.`
    for (const name of await readdir(dir)) if (name.startsWith(prefix) && name.endsWith('.tmp')) await drop(join(dir, name))
    const final = join(dir, `${bot.id}.${ext}`)
    const tmp = join(dir, `${prefix}${randomUUID()}.tmp`)
    let saved: BotDto
    try {
      await writeFile(tmp, bytes)
      saved = await updateBot(paths, bot.id, { avatar: { image: `${DIR}/${bot.id}.${ext}` } })
    } catch (error) {
      await drop(tmp).catch(() => {})
      throw error
    }
    try {
      await rename(tmp, final)
    } catch (error) {
      await updateBot(paths, bot.id, { avatar: previous }).catch(() => {})
      await drop(tmp).catch(() => {})
      throw error
    }
    try {
      await drop(join(dir, `${bot.id}.${ext === 'png' ? 'jpg' : 'png'}`))
    } finally { changed() }
    return saved
  })
}

export function clearBotAvatarImage(paths: VaultPaths, id: unknown, changed: () => void): Promise<BotDto> {
  return locked(paths, id, async () => {
    const bot = await existing(paths, id)
    if (!bot) throw new Error('no such comet')
    let result: BotDto = bot
    if (stored(bot, bot.id)) {
      result = await updateBot(paths, bot.id, { avatar: undefined })
      changed()
    }
    await drop(join(paths.cache, DIR, `${bot.id}.png`))
    await drop(join(paths.cache, DIR, `${bot.id}.jpg`))
    return result
  })
}

export function botAvatarImage(paths: VaultPaths, id: unknown): Promise<{ mime: 'image/png' | 'image/jpeg'; data: Uint8Array } | null> {
  return locked(paths, id, async () => {
    const bot = await existing(paths, id)
    const ext = bot && stored(bot, bot.id)
    if (!bot || !ext) return null
    let handle
    try {
      handle = await open(join(paths.cache, DIR, `${bot.id}.${ext}`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch { return null }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > AVATAR_MAX_BYTES) return null
      const bytes = await handle.readFile()
      const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      try { if (imageType(data) !== ext) return null } catch { return null }
      return { mime: MIME[ext], data }
    } finally { await handle.close() }
  })
}
