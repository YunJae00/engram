import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBot, loadBots } from '../src/bots.js'
import { vaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
vi.mock('../src/rename-with-retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rename-with-retry.js')>()
  return { renameWithRetry: (source: string, target: string) => actual.renameWithRetry(source, target, 'win32') }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const move = vi.mocked(rename)

beforeEach(() => { move.mockReset().mockImplementation(actualFs.rename) })

describe('bot file replacement under Windows file locks', () => {
  it('keeps the previous file readable and holds queued mutations until a retry succeeds', async () => {
    const paths = vaultPaths(await tmpVaultRoot('bots-retry-queue'))
    await createBot(paths, { name: 'Saved' })
    const target = join(paths.cache, 'bots.json')
    const original = await readFile(target, 'utf8')
    let blocked!: () => void
    const locked = new Promise<void>((resolve) => { blocked = resolve })
    let release!: () => void
    const unlocked = new Promise<void>((resolve) => { release = resolve })
    move.mockClear()
      .mockRejectedValueOnce(Object.assign(new Error('File is busy'), { code: 'EBUSY' }))
      .mockImplementationOnce(async (source, destination) => {
        blocked()
        await unlocked
        return actualFs.rename(source, destination)
      })
    const first = createBot(paths, { name: 'First' })
    const second = createBot(paths, { name: 'Second' })
    await locked
    try {
      expect(await readFile(target, 'utf8')).toBe(original)
      expect(move).toHaveBeenCalledTimes(2)
    } finally { release() }
    await Promise.all([first, second])
    expect((await loadBots(paths)).map((bot) => bot.name)).toEqual(['Saved', 'First', 'Second'])
    expect(move.mock.calls[1]).toEqual(move.mock.calls[0])
  })

  it('preserves the saved file on exhausted failure and lets the next queued mutation proceed', async () => {
    const paths = vaultPaths(await tmpVaultRoot('bots-retry-failure'))
    await createBot(paths, { name: 'Saved' })
    const target = join(paths.cache, 'bots.json')
    const original = await readFile(target, 'utf8')
    const error = Object.assign(new Error('Permission denied'), { code: 'EPERM' })
    let attempts = 0
    move.mockClear().mockImplementation(async (source, destination) => {
      if (++attempts <= 6) {
        throw error
      }
      expect(await readFile(target, 'utf8')).toBe(original)
      return actualFs.rename(source, destination)
    })
    const rejected = expect(createBot(paths, { name: 'Rejected' })).rejects.toBe(error)
    const recovered = createBot(paths, { name: 'Recovered' })
    await rejected
    await recovered
    expect(attempts).toBeGreaterThanOrEqual(7)
    expect((await loadBots(paths)).map((bot) => bot.name)).toEqual(['Saved', 'Recovered'])
  })
})
