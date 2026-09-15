import { buildJ11, JobRunner, parseCodexSpan, parseSessionSpan, projectOfTranscript, readAgentsMd, type SessionTurn } from 'core'
import { app, ipcMain } from 'electron'
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LIBRARIAN_RUN_OPTS, noteRunOutcome, runPipelineAsync } from './ipc.js'
import type { VaultContext } from './vault.js'
import { readSessionCursors, writeSessionCursors, type SessionCursor as Cursor } from './session-cursor.js'

// Consent switch — the README privacy table promises AI CLI session harvest
// is off by default. Absent state file = OFF; the Settings toggle writes it.
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

export function isSessionWatchEnabled(): boolean {
  return sessionEnabled
}

export async function setSessionWatchEnabled(enabled: boolean): Promise<void> {
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

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CODEX_DIR = join(homedir(), '.codex', 'sessions')

// A transcript's working directory, for the project label. Codex writes it in
// the head (session_meta); one bounded read per file, cached for the process
// lifetime — this runs inside a 60s scan loop.
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
    /* unreadable head — label falls back below */
  }
  headCwdCache.set(file, cwd)
  return cwd
}

interface HarvestSource {
  id: 'claude' | 'codex'
  parse: (span: string) => { turns: SessionTurn[]; consumed: number }
  list(ctx: VaultContext): Promise<{ file: string; project: string }[]>
}

const SOURCES: HarvestSource[] = [
  {
    id: 'claude',
    parse: parseSessionSpan,
    async list(ctx) {
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
    async list(ctx) {
      // year/month/day — three bounded levels, newest days only would need
      // stat sorting; the cursor map already makes re-listing cheap.
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

// Claude Code names a project folder after its working directory, with the
// separators flattened. Two kinds of directory must never be harvested, and
// both are recognised by that name.
//
// 1. ENGRAM'S OWN. Librarian jobs run with cwd = the vault workspace
//    (engine/types.ts engineCwd), so every job writes a transcript into the
//    very tree this watcher scans. Measured on this machine: 2,202 of 2,235
//    transcripts — 98.5% — were Engram talking to itself, and their "user"
//    turns are librarian prompts quoting note bodies verbatim. Harvesting them
//    would re-ingest the vault into its own inbox, forever, for money.
// 2. THE PRIVATE FOLDER. private/ is the one path the product promises no
//    engine ever sees (vault.ts, agents-template.ts, PrivatePathError). Running
//    claude inside it is the natural thing to do with private notes, and
//    without this check that conversation would be summarised, written to the
//    inbox, and pushed to the user's GitHub backup.
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

// How often to look. Transcripts grow while the user types; there is no hurry,
// and every pass that finds nothing costs one readdir.
const SCAN_MS = 60_000
// A span is only offered to the engine once it has stopped growing for this
// long — mid-thought is exactly when a conclusion has not been reached yet.
const SETTLE_MS = 3 * 60_000
// …and do not let one ask swallow an afternoon: past this, harvest what is
// held and start a fresh span.
const MAX_TURNS_HELD = 40
// Cap on bytes read per file per pass. Measured: a 3MB span filters down to
// ~5.5KB of conversation, so a few MB is routine for one agent run — but a
// transcript can also grow by tens of MB between scans, and this buffer is
// allocated whole on the main process.
const MAX_SPAN_BYTES = 8 * 1024 * 1024

// Titles this conversation has already yielded. Capped: a long session should
// not carry an unbounded list into every prompt, and the recent ones are the
// ones a new span is likely to restate.
const MAX_KEPT_TITLES = 40

// Offsets survive restarts: without that, reopening Engram would re-read every
// transcript from zero and re-harvest a month of work.
function statePath(ctx: VaultContext): string {
  return join(ctx.paths.cache, 'session-cursors.json')
}

let cursors = new Map<string, Cursor>()
let timer: NodeJS.Timeout | null = null
let scanning = false
let starting = false
let sawPriorRun = false

// A first-sight transcript is backfilled from byte zero only when it is
// plausibly the product of the downtime gap. Older than this it is history:
// its conclusions are stale for an inbox that asks questions about them.
const GAP_MAX_AGE_MS = 14 * 86_400_000

// Where reading starts for a transcript seen for the first time. Exported for
// the test: everything around it is filesystem and engine, but THIS branch is
// the difference between "fresh install skips history" and "a reboot loses
// the week the app was off".
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

// Measured on a real machine: 143 project folders, 2,235 transcripts, 267MB of
// them. Cursors for files that no longer exist would accumulate forever, and
// rewriting a 130KB state file once a minute for nothing is pure waste — so the
// state is pruned to what actually exists and only written when it changed.
function pruneCursors(seen: Set<string>): boolean {
  let changed = false
  for (const key of [...cursors.keys()]) {
    if (seen.has(key) || cursors.get(key)?.held.length) continue
    cursors.delete(key)
    changed = true
  }
  return changed
}

// Read the bytes appended since last time. Returns the turns and how far we
// actually got — a half-written final line is left for the next pass.
export async function readNewSpan(
  file: string,
  from: number,
  parse: (span: string) => { turns: SessionTurn[]; consumed: number },
): Promise<{ turns: SessionTurn[]; next: number }> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= from) return { turns: [], next: Math.min(from, size) }
    // Bounded: a transcript can grow by any amount between two scans (a long
    // agent run appends megabytes), and this allocation happens on the main
    // process. Whatever is left over is read on the next pass.
    let length = Math.min(size - from, MAX_SPAN_BYTES)
    for (;;) {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(10) || bytesRead < length || length === size - from) {
        const { turns, consumed } = parse(bytes.toString('utf8'))
        return { turns, next: from + consumed }
      }
      // ponytail: one JSONL row is buffered, capped at 64 MB; use a streaming JSON parser if larger rows become normal.
      if (length >= 64 * 1024 * 1024) throw new Error('Session row exceeds 64 MB; source retained without advancing its checkpoint')
      length = Math.min(size - from, length * 2)
    }
  } finally {
    await handle.close()
  }
}

// Returns false when the span was NOT processed, so the caller can keep it
// rather than moving past it. A usage limit lasts hours and `auth status` still
// says logged in throughout, so without this the watcher would hand a settled
// span to a halted engine once a minute, drop it, and lose every conclusion the
// user reached during the window — silently, since the offset had already moved.
async function harvest(ctx: VaultContext, project: string, cursor: Cursor): Promise<boolean> {
  if (ctx.engines.length === 0) return false
  const runner = new JobRunner(ctx.paths, ctx.engines, LIBRARIAN_RUN_OPTS)
  const report = await runner.runAll([
    buildJ11(ctx.paths, await readAgentsMd(ctx.paths), project, cursor.held.slice(0, MAX_TURNS_HELD), cursor.kept, (title) => {
      cursor.kept.push(title)
      if (cursor.kept.length > MAX_KEPT_TITLES) cursor.kept = cursor.kept.slice(-MAX_KEPT_TITLES)
    }),
  ])
  // Feed the shared health verdict, so a quota or auth halt raises the same
  // banner the rest of the librarian does instead of failing invisibly here.
  noteRunOutcome(ctx, report)
  if (report.haltReason || report.failed.length > 0 || report.deferred > 0) return false
  // Anything harvested landed in the inbox; from here it is an ordinary
  // capture and the existing pipeline absorbs, links and files it.
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
      for (const entry of await source.list(ctx)) {
        const file = entry.file
        const info = await stat(file).catch(() => null)
        if (!info) continue
        seen.add(file)

        const cursor = cursors.get(file) ?? { offset: 0, held: [], lastGrewAt: now, kept: [] }
        if (!cursors.has(file)) {
          // FIRST SIGHT: two different worlds share this branch.
          //
          // Fresh install (no prior cursor state): adopt the end, for every
          // file. Gating this on staleness meant the very first run read every
          // transcript touched in the last day from byte zero — measured at
          // 83MB in one pass, allocated whole on the main process, 96% of the
          // parsed turns then discarded. What happened before Engram was
          // installed is not its business.
          //
          // Prior run existed: a first-sight file younger than the gap window
          // was BORN while Engram was off — the user kept working in Claude
          // and those conclusions are precisely what a second brain must not
          // lose. Leave the offset at zero and the growth path below reads it
          // like any other append, bounded (MAX_SPAN_BYTES per pass) and
          // settled through the same J11 flow. Anything older is history and
          // still adopts its end.
          cursors.set(file, cursor)
          dirtyState = true
          cursor.offset = firstSightOffset(sawPriorRun, info.mtimeMs, info.size, now)
          if (cursor.offset >= info.size) continue
        }
        // Backpressure leaves unread bytes in the source instead of dropping old pending turns.
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

// Starts with the app and stops with it — that is the whole contract.
export async function startSessionWatch(ctx: VaultContext): Promise<void> {
  // Packaged only: a dev run or an e2e worker must not harvest the developer's
  // real conversations into whatever vault the test happens to open.
  if (!app.isPackaged && process.env['ENGRAM_SESSION_WATCH'] !== '1') return
  watchCtx = ctx
  sessionEnabled = process.env['ENGRAM_SESSION_WATCH'] === '1' || (await readSessionState())
  if (!sessionEnabled) return // consent first — the Settings toggle starts us
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
