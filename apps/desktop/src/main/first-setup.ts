import { ipcMain } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FirstSetupDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import type { VaultContext } from './vault.js'

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
  ipcMain.handle('firstSetup:skip', async () => {
    if (vault) await rm(join(vault.paths.cache, PENDING), { force: true })
    tell()
  })
}
