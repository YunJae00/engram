import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VaultContext } from '../src/main/vault.js'

const fake = vi.hoisted(() => ({ handlers: new Map<string, () => Promise<unknown>>(), broadcast: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: () => Promise<unknown>) => fake.handlers.set(name, handler) } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast }))
import { firstSetupDone, markFirstSetup, registerFirstSetupIpc, reportFirstSetup } from '../src/main/first-setup.js'

let cache: string
let ctx: VaultContext
const status = () => fake.handlers.get('firstSetup:status')!()
beforeEach(async () => {
  vi.stubEnv('ENGRAM_USERDATA', '')
  cache = await mkdtemp(join(tmpdir(), 'engram-setup-test-'))
  ctx = { paths: { cache } } as VaultContext
  registerFirstSetupIpc(ctx)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(cache, { recursive: true, force: true }) })

it('holds a new vault across registration until filing completes', async () => {
  expect(await status()).toMatchObject({ waiting: false })
  await markFirstSetup(ctx)
  registerFirstSetupIpc(ctx)
  expect(await status()).toMatchObject({ waiting: true, phase: 'ai' })
  reportFirstSetup({ phase: 'filing', done: 2, total: 5 })
  expect(await status()).toMatchObject({ waiting: true, phase: 'filing', done: 2, total: 5 })
  await writeFile(join(cache, 'first-filing.json'), '{}')
  await firstSetupDone(ctx)
  expect(await status()).toMatchObject({ waiting: false, phase: 'done' })
  await markFirstSetup(ctx)
  expect(await status()).toMatchObject({ waiting: false })
})

it('sets aside a failed wait without marking the unfinished filing complete', async () => {
  await markFirstSetup(ctx)
  reportFirstSetup({ phase: 'retrying', reason: 'paused', retryAt: 100 })
  expect(await status()).toMatchObject({ waiting: true, phase: 'retrying' })
  await fake.handlers.get('firstSetup:skip')!()
  expect(await status()).toMatchObject({ waiting: false })
  await expect(readFile(join(cache, 'first-filing.json'))).rejects.toThrow()
})

it('clears a previous failure when filing resumes', async () => {
  await markFirstSetup(ctx)
  reportFirstSetup({ phase: 'retrying', reason: 'paused', retryAt: 100 })
  reportFirstSetup({ phase: 'filing' })
  expect(await status()).not.toHaveProperty('reason')
  expect(await status()).not.toHaveProperty('retryAt')
})
