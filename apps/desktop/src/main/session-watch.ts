import { buildJ11, JobRunner, parseCodexSpan, parseSessionSpan, projectOfTranscript, readAgentsMd, type SessionTurn } from 'core'
import { app, ipcMain } from 'electron'
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLibrarianBusy, LIBRARIAN_RUN_OPTS, noteRunOutcome, runExclusiveFiling, runPipelineAsync } from './ipc.js'
import type { VaultContext } from './vault.js'
import { readSessionCursors, writeSessionCursors, type SessionCursor as Cursor } from './session-cursor.js'
import { accountEnvironment, accountProfiles } from './account-profiles.js'

const SESSION_STATE_FILE = () => join(app.getPath('userData'), 'session-watch.json')
let sessionEnabled = false
let watchCtx: VaultContext | null = null

async function readSessionState(): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(SESSION_STATE_FILE(), 'utf8')) as { enabled?: boolean }).enabled === true
  } catch {
    return false
  }
}

function isSessionWatchEnabled(): boolean {
  return sessionEnabled
}

async function setSessionWatchEnabled(enabled: boolean): Promise<void> {
  sessionEnabled = enabled
  await writeFile(SESSION_STATE_FILE(), JSON.stringify({ enabled })).catch(() => undefined)
  if (enabled && watchCtx) void startTimer(watchCtx)
  if (!enabled) stopSessionWatch()
}

export function registerSessionWatchIpc(): void {
  ipcMain.handle('sessionwatch:get', () => isSessionWatchEnabled())
  ipcMain.handle('sessionwatch:set', async (_e, enabled: boolean) => {
    await setSessionWatchEnabled(enabled)
    return isSessionWatchEnabled()
  })
}

const headCwdCache = new Map<string, string | null>()
async function headCwd(file: string): Promise<string | null> {
  if (headCwdCache.has(file)) return headCwdCache.get(file) ?? null
  let cwd: string | null = null
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(8_192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buffer.toString('utf8', 0, bytesRead))
      if (match?.[1]) cwd = JSON.parse(`"${match[1]}"`) as string
    } finally {
      await handle.close()
    }
  } catch {
  }
  headCwdCache.set(file, cwd)
  return cwd
}

interface HarvestSource {
  id: 'claude' | 'codex'
  parse: (span: string) => Promise<{ turns: SessionTurn[]; consumed: number }>
  list(ctx: VaultContext, env: NodeJS.ProcessEnv): Promise<{ file: string; project: string }[]>
}

const SOURCES: HarvestSource[] = [
  {
    id: 'claude',
    parse: parseSessionSpan,
    async list(ctx, env) {
      const PROJECTS_DIR = join(env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')
      const out: { file: string; project: string }[] = []
      const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => [])
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        if (isOffLimits(dir.name, ctx)) continue
        const full = join(PROJECTS_DIR, dir.name)
        for (const name of await readdir(full).catch(() => [])) {
          if (name.endsWith('.jsonl')) out.push({ file: join(full, name), project: projectOfTranscript(dir.name) })
        }
      }
      return out
    },
  },
  {
    id: 'codex',
    parse: parseCodexSpan,
    async list(ctx, env) {
      const CODEX_DIR = join(env['CODEX_HOME'] || join(homedir(), '.codex'), 'sessions')
      const out: { file: string; project: string }[] = []
      const years = await readdir(CODEX_DIR, { withFileTypes: true }).catch(() => [])
      for (const y of years) {
        if (!y.isDirectory()) continue
        for (const m of await readdir(join(CODEX_DIR, y.name), { withFileTypes: true }).catch(() => [])) {
          if (!m.isDirectory()) continue
          for (const d of await readdir(join(CODEX_DIR, y.name, m.name), { withFileTypes: true }).catch(() => [])) {
            if (!d.isDirectory()) continue
            const day = join(CODEX_DIR, y.name, m.name, d.name)
            for (const name of await readdir(day).catch(() => [])) {
              if (!name.endsWith('.jsonl')) continue
              const file = join(day, name)
              const cwd = await headCwd(file)
              if (cwd && isOffLimits(cwd, ctx)) continue
              const project = cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'codex') : 'codex'
              out.push({ file, project })
            }
          }
        }
      }
      return out
    },
  },
]

function flattenedPath(dir: string): string {
  return dir.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isOffLimits(dirName: string, ctx: VaultContext): boolean {
  const name = flattenedPath(dirName)
  return [ctx.paths.workspace, ctx.paths.privateDir].some((p) => {
    const target = flattenedPath(p)
    return target.length > 0 && name.includes(target)
  })
}

const SCAN_MS = 60_000
const SETTLE_MS = 3 * 60_000
const MAX_TURNS_HELD = 40
const MAX_SPAN_BYTES = 8 * 1024 * 1024

const MAX_KEPT_TITLES = 40

function statePath(ctx: VaultContext): string {
  return join(ctx.paths.cache, 'session-cursors.json')
}

let cursors = new Map<string, Cursor>()
let timer: NodeJS.Timeout | null = null
let scanning = false
let starting = false
let sawPriorRun = false

const GAP_MAX_AGE_MS = 14 * 86_400_000

export function firstSightOffset(priorRun: boolean, mtimeMs: number, size: number, now: number): number {
  return priorRun && now - mtimeMs <= GAP_MAX_AGE_MS ? 0 : size
}

async function loadCursors(ctx: VaultContext): Promise<void> {
  const saved = await readSessionCursors(statePath(ctx))
  cursors = saved ?? new Map()
  sawPriorRun = saved !== null
}

async function saveCursors(ctx: VaultContext): Promise<void> {
  await writeSessionCursors(statePath(ctx), cursors)
}

function pruneCursors(seen: Set<string>): boolean {
  let changed = false
  for (const key of [...cursors.keys()]) {
    if (seen.has(key) || cursors.get(key)?.held.length) continue
    cursors.delete(key)
    changed = true
  }
  return changed
}

export async function readNewSpan(
  file: string,
  from: number,
  parse: (span: string) => Promise<{ turns: SessionTurn[]; consumed: number }>,
): Promise<{ turns: SessionTurn[]; next: number }> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= from) return { turns: [], next: Math.min(from, size) }
    let length = Math.min(size - from, MAX_SPAN_BYTES)
    for (;;) {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(10) || bytesRead < length || length === size - from) {
        const { turns, consumed } = await parse(bytes.toString('utf8'))
        return { turns, next: from + consumed }
      }
      if (length >= 64 * 1024 * 1024) throw new Error('Session row exceeds 64 MB; source retained without advancing its checkpoint')
      length = Math.min(size - from, length * 2)
    }
  } finally {
    await handle.close()
  }
}

async function harvest(ctx: VaultContext, project: string, cursor: Cursor): Promise<boolean> {
  if (ctx.engines.length === 0 || isLibrarianBusy()) return false
  const runEngine = ctx.engines[0]
  const runner = new JobRunner(ctx.paths, ctx.engines, LIBRARIAN_RUN_OPTS)
  const report = await runExclusiveFiling(ctx, async () => runner.runAll([
    buildJ11(ctx.paths, await readAgentsMd(ctx.paths), project, cursor.held.slice(0, MAX_TURNS_HELD), cursor.kept, (title) => {
      cursor.kept.push(title)
      if (cursor.kept.length > MAX_KEPT_TITLES) cursor.kept = cursor.kept.slice(-MAX_KEPT_TITLES)
    }),
  ]))
  noteRunOutcome(ctx, report, runEngine)
  if (report.haltReason || report.failed.length > 0 || report.deferred > 0) return false
  if (report.executed > 0) runPipelineAsync(ctx, 'librarian: session harvest')
  return true
}

const MAX_HARVESTS_PER_SCAN = 2

export async function scanSessions(ctx: VaultContext): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const now = Date.now()
    const seen = new Set<string>()
    let grew = 0
    let harvested = 0
    let dirtyState = false
    for (const source of SOURCES) {
      const profiles = ['system', ...accountProfiles().profiles.filter(profile => profile.provider === source.id).map(profile => profile.id)]
      const entries = []
      for (const profile of profiles) entries.push(...await source.list(ctx, accountEnvironment(source.id, profile)))
      for (const entry of entries) {
        const file = entry.file
        const info = await stat(file).catch(() => null)
        if (!info) continue
        seen.add(file)

        const cursor = cursors.get(file) ?? { offset: 0, held: [], lastGrewAt: now, kept: [] }
        if (!cursors.has(file)) {
          cursors.set(file, cursor)
          dirtyState = true
          cursor.offset = firstSightOffset(sawPriorRun, info.mtimeMs, info.size, now)
          if (cursor.offset >= info.size) continue
        }
        if (info.size > cursor.offset && cursor.held.length < MAX_TURNS_HELD) {
          const { turns, next } = await readNewSpan(file, cursor.offset, source.parse)
          cursor.offset = next
          dirtyState = true
          if (turns.length > 0) {
            cursor.held.push(...turns)
            cursor.lastGrewAt = now
            grew += turns.length
          }
        }

        const settled = now - cursor.lastGrewAt >= SETTLE_MS
        const overflowing = cursor.held.length >= MAX_TURNS_HELD
        if (ctx.engines.length > 0 && harvested < MAX_HARVESTS_PER_SCAN && cursor.held.length > 0 && (settled || overflowing)) {
          await saveCursors(ctx)
          harvested += 1
          const ok = await harvest(ctx, entry.project, cursor).catch((err) => {
            console.error('session harvest failed (non-fatal):', err)
            return false
          })
          if (ok) {
            cursor.held.splice(0, MAX_TURNS_HELD)
          }
          await saveCursors(ctx)
        }
      }
    }
    if (pruneCursors(seen)) dirtyState = true
    if (dirtyState) await saveCursors(ctx)
    if (grew > 0 || harvested > 0) {
      console.log(`session watch: ${seen.size} transcripts, +${grew} turns, ${harvested} span(s) harvested`)
    }
  } finally {
    scanning = false
  }
}

export async function startSessionWatch(ctx: VaultContext): Promise<void> {
  if (!app.isPackaged && process.env['ENGRAM_SESSION_WATCH'] !== '1') return
  watchCtx = ctx
  sessionEnabled = process.env['ENGRAM_SESSION_WATCH'] === '1' || (await readSessionState())
  if (!sessionEnabled) return
  await startTimer(ctx)
}

async function startTimer(ctx: VaultContext): Promise<void> {
  if (timer || starting) return
  starting = true
  try {
    await loadCursors(ctx)
    if (!sessionEnabled) return
    const run = () => void scanSessions(ctx).catch(error => console.error('session watch failed:', error))
    timer = setInterval(run, SCAN_MS)
    await scanSessions(ctx)
  } catch (error) {
    console.error('session watch could not restore pending work:', error)
  } finally {
    starting = false
  }
}

export function stopSessionWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
}
