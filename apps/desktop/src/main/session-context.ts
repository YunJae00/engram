import { buildContextBlock } from 'core'
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VaultContext } from './vault.js'

// Give every Claude session the user's situation before it says anything.
//
// The vault already holds it; nothing was handing it over. The MCP tools are
// pull-only — the model must decide to search, and over a long working session
// it captured only when told and searched exactly never. So Engram pushes: it
// keeps one small file in the vault, and Claude Code imports that file at the
// top of every session through the user's ~/.claude/CLAUDE.md.
//
// Two files, two owners, deliberately:
//   _views/context.md   Engram owns it, rewrites it after every tidy
//   ~/.claude/CLAUDE.md the USER owns it — we add ONE @import line, once,
//                       inside markers, and never touch anything else
// So the thing that changes constantly is inside the vault, and the thing we
// touch in the user's config is a single line they can delete.

const CONTEXT_FILE = 'context.md'
const IMPORT_BEGIN = '<!-- engram:import -->'
const IMPORT_END = '<!-- engram:/import -->'

function contextPath(ctx: VaultContext): string {
  return join(ctx.paths.views, CONTEXT_FILE)
}

// Rewritten from the live store, so it is never staler than the last sweep.
async function writeSessionContext(ctx: VaultContext): Promise<void> {
  const block = buildContextBlock(ctx.store.getAll())
  const target = contextPath(ctx)
  const current = await readFile(target, 'utf8').catch(() => null)
  // Byte-identical writes would churn the file watcher and the git layer for
  // nothing — a vault whose notes have not moved has nothing new to say.
  if (current === block) return
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, block, 'utf8')
}

// The one line in the user's own file. Idempotent, marker-delimited, and only
// ever written when the path actually differs — so a moved or reinstalled vault
// self-heals and an unchanged one is left alone.
async function linkSessionContext(ctx: VaultContext): Promise<boolean> {
  // PACKAGED ONLY. This is the one file here that belongs to the user rather
  // than to Engram, and it is global to every Claude session on the machine —
  // a dev run or an e2e worker must never edit the developer's real config.
  if (!app.isPackaged) return false
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

// Both halves, best effort: a session that starts without context is worse than
// one that starts with stale context, and neither is worth crashing a boot for.
export async function syncSessionContext(ctx: VaultContext): Promise<void> {
  await writeSessionContext(ctx).catch((err) => console.error('context write failed (non-fatal):', err))
  await linkSessionContext(ctx).catch((err) => console.error('context link failed (non-fatal):', err))
}
