import { buildContextBlock } from 'core'
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VaultContext } from './vault.js'

const CONTEXT_FILE = 'context.md'
const IMPORT_BEGIN = '<!-- engram:import -->'
const IMPORT_END = '<!-- engram:/import -->'

function contextPath(ctx: VaultContext): string {
  return join(ctx.paths.views, CONTEXT_FILE)
}

async function writeSessionContext(ctx: VaultContext): Promise<void> {
  const block = buildContextBlock(ctx.store.getAll())
  const target = contextPath(ctx)
  const current = await readFile(target, 'utf8').catch(() => null)
  if (current === block) return
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, block, 'utf8')
}

async function linkSessionContext(ctx: VaultContext): Promise<boolean> {
  if (!app.isPackaged || process.env['ENGRAM_VAULT']) return false
  const target = join(homedir(), '.claude', 'CLAUDE.md')
  const line = `@${contextPath(ctx).replace(/\\/g, '/')}`
  const block = [
    IMPORT_BEGIN,
    '<!-- Engram keeps this file up to date with what you are working on.',
    '     Delete this block to stop importing it. -->',
    line,
    IMPORT_END,
  ].join('\n')

  const current = await readFile(target, 'utf8').catch(() => '')
  if (current.includes(line)) return false

  const start = current.indexOf(IMPORT_BEGIN)
  const end = current.indexOf(IMPORT_END)
  const next =
    start !== -1 && end !== -1 && end > start
      ? current.slice(0, start) + block + current.slice(end + IMPORT_END.length)
      : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, next, 'utf8')
  return true
}

export async function syncSessionContext(ctx: VaultContext): Promise<void> {
  await writeSessionContext(ctx).catch((err) => console.error('context write failed (non-fatal):', err))
  await linkSessionContext(ctx).catch((err) => console.error('context link failed (non-fatal):', err))
}
