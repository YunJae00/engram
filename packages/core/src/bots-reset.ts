import { randomBytes, randomInt } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addNotice, readNotices } from './notices.js'
import { renameWithRetry } from './rename-with-retry.js'
import type { VaultPaths } from './vault.js'

type Rename = (from: string, to: string) => Promise<void>

const BACKUP_NAME = /^bots-v1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/
const MARKER = '.reset-incomplete'
const PERSON = '_person.json'

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (code(error) === 'ENOENT') return []
    throw error
  }
}

function decodeObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

async function isV2(file: string): Promise<boolean> {
  try {
    return decodeObject(await readFile(file))?.['version'] === 2
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'EISDIR') return false
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function countSchedules(file: string): Promise<number | undefined> {
  let parsed: Record<string, unknown> | null
  try {
    parsed = decodeObject(await readFile(file))
  } catch {
    return undefined
  }
  const bots = parsed?.['bots']
  if (!Array.isArray(bots)) return undefined
  let count = 0
  for (let i = 0; i < bots.length; i++) {
    const bot: unknown = bots[i]
    const tasks = bot !== null && typeof bot === 'object' ? (bot as Record<string, unknown>)['tasks'] : undefined
    if (!Array.isArray(tasks)) continue
    for (let j = 0; j < tasks.length; j++) {
      const task: unknown = tasks[j]
      if (task !== null && typeof task === 'object' && isRecord((task as Record<string, unknown>)['schedule'])) count++
    }
  }
  return count
}

// Writes through a fresh scratch name so no pre-existing *.tmp is ever overwritten or consumed.
async function publish(target: string, data: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const scratch = `${target}.reset-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(scratch, data, { flag: 'wx' })
    } catch (error) {
      if (code(error) === 'EEXIST') continue
      throw error
    }
    try {
      await renameWithRetry(scratch, target)
    } catch (error) {
      await unlink(scratch).catch((cleanup: unknown) => { if (code(cleanup) !== 'ENOENT') throw cleanup })
      throw error
    }
    return
  }
  throw new Error(`could not create a scratch file next to ${target}`)
}

interface BackupState { root: string; unfinished: string[]; taken: Set<string> }

async function backupState(cache: string): Promise<BackupState> {
  const root = join(cache, 'backups')
  const state: BackupState = { root, unfinished: [], taken: new Set() }
  const info = await lstatOrNull(root)
  if (!info) return state
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`)
  for (const name of await readdir(root)) {
    if (!BACKUP_NAME.test(name)) continue
    const entry = await lstatOrNull(join(root, name))
    if (!entry) continue
    state.taken.add(name)
    if (!entry.isDirectory()) continue
    const inside = await readdir(join(root, name))
    if (inside.length === 0 || inside.includes(MARKER)) state.unfinished.push(name)
  }
  return state
}

async function pickFolder(state: BackupState, now: Date): Promise<string> {
  if (state.unfinished.length > 0) {
    const folder = state.unfinished.reduce((a, b) => (b > a ? b : a))
    await writeFile(join(state.root, folder, MARKER), '')
    return folder
  }
  await mkdir(state.root, { recursive: true })
  const base = 'bots-v1-' + now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (let n = 1; ; n++) {
    const folder = n === 1 ? base : `${base}-${n}`
    if (state.taken.has(folder)) continue
    try {
      await mkdir(join(state.root, folder))
    } catch (error) {
      if (code(error) === 'EEXIST') continue
      throw error
    }
    await writeFile(join(state.root, folder, MARKER), '')
    return folder
  }
}

async function moveEntry(rename: Rename, cache: string, backup: string, relative: string): Promise<void> {
  const source = join(cache, relative)
  if (!(await lstatOrNull(source))) return
  const target = join(backup, relative)
  if (await lstatOrNull(target)) throw new Error(`backup entry already exists: ${target}`)
  await mkdir(join(target, '..'), { recursive: true })
  await rename(source, target)
}

async function addResetNotice(paths: VaultPaths, folder: string, count: number | undefined): Promise<void> {
  const key = `bots-reset:${folder}`
  if ((await readNotices(paths)).some(item => item.key === key)) return
  const text = `이전 대화는 백업 폴더에 있어요 (.engram/backups/${folder})` + (count !== undefined && count >= 1 ? ` 일정 ${count}개가 멈췄어요` : '')
  // addNotice writes through the fixed notices.json.tmp, so a leftover of that name is copied aside and linked back.
  const leftover = join(paths.cache, 'notices.json.tmp')
  const kept = join(paths.cache, `notices.json.kept-${process.pid}-${randomBytes(4).toString('hex')}`)
  const saved = await copyFile(leftover, kept, constants.COPYFILE_EXCL).then(() => true, (error: unknown) => {
    if (code(error) === 'ENOENT') return false
    throw error
  })
  try {
    await addNotice(paths, { kind: 'system', key, title: '봇을 새로 시작했어요', text })
  } finally {
    if (saved) {
      await link(kept, leftover).catch((error: unknown) => { if (code(error) !== 'EEXIST') throw error })
      await unlink(kept)
    }
  }
}

export async function resetBotsToV2(paths: VaultPaths, opts: { now?: Date; rename?: Rename } = {}): Promise<void> {
  const cache = paths.cache
  const listFile = join(cache, 'bots.json')
  if (await isV2(listFile)) return
  const now = opts.now ?? new Date()
  const rename = opts.rename ?? renameWithRetry

  const state = await backupState(cache)
  const sources: string[] = []
  for (const name of await namesIn(join(cache, 'bot-chats'))) sources.push(join('bot-chats', name))
  for (const name of await namesIn(join(cache, 'bot-memory'))) if (name !== PERSON) sources.push(join('bot-memory', name))
  if (await lstatOrNull(listFile)) sources.push('bots.json')

  if (sources.length > 0 || state.unfinished.length > 0) {
    const folder = await pickFolder(state, now)
    const backup = join(state.root, folder)
    for (const relative of sources) await moveEntry(rename, cache, backup, relative)
    await addResetNotice(paths, folder, await countSchedules(join(backup, 'bots.json')))
    await unlink(join(backup, MARKER)).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error })
  }

  const stamp = now.toISOString()
  const id = `bot-${Math.max(0, now.getTime()).toString(36)}-${randomInt(0x10000).toString(16)}`
  const list = { version: 2, bots: [{ id, name: 'Engram', purpose: '', createdAt: stamp, updatedAt: stamp, primary: true }], dismissed: [] }
  await mkdir(cache, { recursive: true })
  await publish(listFile, JSON.stringify(list, null, 2))
}
