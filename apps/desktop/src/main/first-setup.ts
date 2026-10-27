import { ipcMain } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FirstSetupDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import type { VaultContext } from './vault.js'

// A vault made by setup is not opened until its first filing is done: the
// window holds a setup screen meanwhile, so the first conversation and the
// first look at Cosmos already know the person's work. A vault opened from
// before - or one whose setup the person set aside after a failure - is not held.
const PENDING = 'first-setup.json'
const FILED = 'first-filing.json'

type Progress = Omit<FirstSetupDto, 'waiting'>
let progress: Progress = { phase: 'ai', done: 0, total: 0, startedAt: Date.now() }
let vault: VaultContext | null = null

const exists = (path: string): Promise<boolean> => readFile(path, 'utf8').then(() => true, () => false)

async function current(ctx: VaultContext | null): Promise<FirstSetupDto> {
  if (!ctx || process.env['ENGRAM_USERDATA']) return { ...progress, waiting: false, phase: 'done' }
  const waiting = await exists(join(ctx.paths.cache, PENDING)) && !await exists(join(ctx.paths.cache, FILED))
  return { ...progress, waiting, ...(waiting ? {} : { phase: 'done' as const }) }
}

const tell = (): void => { void current(vault).then(status => broadcast({ type: 'firstSetup:changed', status })) }

export async function markFirstSetup(ctx: VaultContext): Promise<void> {
  progress = { phase: 'ai', done: 0, total: 0, startedAt: Date.now() }
  if (!await exists(join(ctx.paths.cache, FILED))) await writeFile(join(ctx.paths.cache, PENDING), JSON.stringify({ at: new Date().toISOString() }))
  tell()
}

// Where the first filing is, said to the setup screen as it moves.
export function reportFirstSetup(next: Partial<Omit<Progress, 'startedAt'>>): void {
  const base: Progress = { ...progress }
  if (next.phase && next.phase !== 'retrying') { delete base.reason; delete base.retryAt }
  progress = { ...base, ...next }
  tell()
}

export async function firstSetupDone(ctx: VaultContext): Promise<void> {
  await rm(join(ctx.paths.cache, PENDING), { force: true })
  progress = { ...progress, phase: 'done' }
  tell()
}

export function registerFirstSetupIpc(ctx: VaultContext): void {
  vault = ctx
  ipcMain.handle('firstSetup:status', () => current(vault))
  // Set aside by the person after it could not finish: the filing goes on in the background.
  ipcMain.handle('firstSetup:skip', async () => {
    if (vault) await rm(join(vault.paths.cache, PENDING), { force: true })
    tell()
  })
}
