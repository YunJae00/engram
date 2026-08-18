import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { flog } from './flog.js'
import type { VaultContext } from './vault.js'

const SAMPLE_MS = 15_000
const MIN_SPAN_MS = 60_000
const DENY_RE = /password|비밀번호|은행|bank|secret|incognito|시크릿|private browsing/i

export interface ActivitySpan {
  app: string
  title: string
  start: string
  end: string
}

interface Sample {
  app: string
  title: string
}

// The folding rule, pure for its test: same app+title extends the open span;
// anything else closes it (returned for flushing when long enough) and opens
// a new one.
export interface OpenSpan extends Sample {
  startedAt: number
  lastSeenAt: number
}

export function foldSample(
  current: OpenSpan | null,
  sample: Sample | null,
  now: number,
): { next: OpenSpan | null; closed: OpenSpan | null } {
  if (current && sample && current.app === sample.app && current.title === sample.title) {
    return { next: { ...current, lastSeenAt: now }, closed: null }
  }
  const next = sample ? { ...sample, startedAt: now, lastSeenAt: now } : null
  const closed = current && current.lastSeenAt - current.startedAt >= MIN_SPAN_MS ? current : null
  return { next, closed }
}

export function sanitizeTitle(title: string): string {
  return DENY_RE.test(title) ? '(private)' : title.slice(0, 120)
}

// One PowerShell child for the whole life of the watcher: Add-Type once,
// foreground process+title every 15s, one pipe-separated line each.
const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) {
  try {
    $h = [FG]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][FG]::GetWindowText($h, $sb, 512)
    $procId = 0
    [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
    $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    if ($name) { Write-Output ($name + '|' + $sb.ToString()) }
  } catch {}
  Start-Sleep -Milliseconds ${SAMPLE_MS}
}
`.replace('${SAMPLE_MS}', String(SAMPLE_MS))

interface ActivityState {
  enabled?: boolean
}

let child: ChildProcess | null = null
let ctx: VaultContext | null = null
let open: OpenSpan | null = null

function stateFile(): string {
  return join(app.getPath('userData'), 'activity-state.json')
}

async function readState(): Promise<ActivityState> {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8')) as ActivityState
  } catch {
    return {}
  }
}

function ledgerDir(vault: VaultContext): string {
  return join(vault.paths.workspace, '.engram', 'activity')
}

function dayFile(vault: VaultContext, at: number): string {
  return join(ledgerDir(vault), `${new Date(at).toISOString().slice(0, 10)}.jsonl`)
}

async function flush(span: OpenSpan): Promise<void> {
  if (!ctx) return
  const record: ActivitySpan = {
    app: span.app,
    title: sanitizeTitle(span.title),
    start: new Date(span.startedAt).toISOString(),
    end: new Date(span.lastSeenAt).toISOString(),
  }
  await mkdir(ledgerDir(ctx), { recursive: true }).catch(() => undefined)
  await appendFile(dayFile(ctx, span.startedAt), `${JSON.stringify(record)}\n`).catch(() => undefined)
}

function onSample(sample: Sample | null): void {
  const now = Date.now()
  const { next, closed } = foldSample(open, sample, now)
  open = next
  if (closed) void flush(closed)
}

export function isActivityWatchEnabled(): boolean {
  return child !== null
}

export async function setActivityWatchEnabled(enabled: boolean): Promise<void> {
  await writeFile(stateFile(), JSON.stringify({ enabled })).catch(() => undefined)
  if (enabled) startSampler()
  else stopActivityWatch()
}

// macOS twin of the PS sampler: an osascript (JXA) probe in a shell loop —
// same 15s cadence, same "app|title" line protocol. Window TITLES need the
// Accessibility permission; without it the probe still reports the app name
// and the title arrives empty, which the fold handles like any other sample.
// The loop condition is the app's own liveness, not `true`. This shell does
// not write to the pipe it was given — only its osascript grandchild does —
// so a dead parent never reaches it as EPIPE, and `while true` would keep
// waking System Events every 15 seconds forever, one surviving loop per
// unclean exit, across app restarts and unreachable by any reaper. Asking
// after the pid that started us is what ends it.
const MAC_SCRIPT = `while kill -0 ${process.pid} 2>/dev/null; do osascript -l JavaScript -e '
const se = Application("System Events");
const p = se.processes.whose({ frontmost: true })[0];
let t = "";
try { t = p.windows[0].title() } catch (e) {}
p.name() + "|" + t' 2>/dev/null; sleep ${SAMPLE_MS / 1000}; done`

function samplerSpawn(): ChildProcess {
  if (process.platform === 'darwin') {
    return spawn('/bin/sh', ['-c', MAC_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
  }
  return spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

function startSampler(): void {
  if (child || !ctx) return
  try {
    child = samplerSpawn()
    // The sampler yields like every other background child (same rule as
    // core/spawn.ts track): BELOW_NORMAL, best-effort.
    if (child.pid !== undefined) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        /* already gone */
      }
    }
  } catch (err) {
    flog('activity-watch-failed', err)
    child = null
    return
  }
  child.stdout?.setEncoding('utf8')
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const at = line.indexOf('|')
      if (at <= 0) return
      const appName = line.slice(0, at).trim()
      const title = line.slice(at + 1).trim()
      // Engram watching itself is noise, and an empty title is a desktop.
      if (!appName || appName.toLowerCase() === 'engram') return
      onSample({ app: appName, title })
    })
  }
  child.on('exit', () => {
    child = null
  })
  flog('activity-watch', 'sampler started')
}

const RETAIN_DAYS = 60

async function pruneOldDays(vault: VaultContext): Promise<void> {
  const dir = ledgerDir(vault)
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const name of await readdir(dir).catch(() => [])) {
    const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1]
    if (day !== undefined && day < cutoff) await unlink(join(dir, name)).catch(() => undefined)
  }
}

export async function startActivityWatch(vault: VaultContext): Promise<void> {
  if ((process.platform !== 'win32' && process.platform !== 'darwin') || process.env['ENGRAM_HIDDEN'] === '1') return
  ctx = vault
  void pruneOldDays(vault)
  const state = await readState()
  // Default ON — the journal is the feature; the tray checkbox is the switch.
  if (state.enabled !== false) startSampler()
}

export function registerActivityIpc(): void {
  ipcMain.handle('activity:get', () => isActivityWatchEnabled())
  ipcMain.handle('activity:set', async (_e, enabled: boolean) => {
    await setActivityWatchEnabled(enabled)
    return isActivityWatchEnabled()
  })
  ipcMain.handle('activity:today', async () => {
    if (!ctx) return { totalMs: 0, apps: [] }
    const spans: ActivitySpan[] = await readDaySpans(ctx, Date.now()).catch(() => [])
    if (open && Date.now() - open.startedAt >= MIN_SPAN_MS) {
      spans.push({
        app: open.app,
        title: sanitizeTitle(open.title),
        start: new Date(open.startedAt).toISOString(),
        end: new Date().toISOString(),
      })
    }
    const apps = aggregate(spans).slice(0, 6)
    return { totalMs: apps.reduce((sum, a) => sum + a.ms, 0), apps }
  })
}

export function stopActivityWatch(): void {
  if (open && open.lastSeenAt - open.startedAt >= MIN_SPAN_MS) void flush(open)
  open = null
  if (child) {
    child.kill('SIGKILL')
    child = null
  }
}

// Per-app aggregation shared by the chat summary and the daily work log.
function aggregate(spans: ActivitySpan[]): { app: string; ms: number; topTitles: string[] }[] {
  const byApp = new Map<string, { ms: number; titles: Map<string, number> }>()
  for (const span of spans) {
    const ms = Date.parse(span.end) - Date.parse(span.start)
    const entry = byApp.get(span.app) ?? { ms: 0, titles: new Map() }
    entry.ms += ms
    entry.titles.set(span.title, (entry.titles.get(span.title) ?? 0) + ms)
    byApp.set(span.app, entry)
  }
  return [...byApp.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([appName, entry]) => ({
      app: appName,
      ms: entry.ms,
      topTitles: [...entry.titles.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([title]) => title)
        .filter((title) => title !== '(private)')
        .slice(0, 3),
    }))
}

export async function readDaySpans(vault: VaultContext, at: number): Promise<ActivitySpan[]> {
  const raw = await readFile(dayFile(vault, at), 'utf8').catch(() => null)
  if (!raw) return []
  const spans: ActivitySpan[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      spans.push(JSON.parse(line) as ActivitySpan)
    } catch {
      continue
    }
  }
  return spans
}

export function composeWorklog(day: string, spans: ActivitySpan[]): string | null {
  const apps = aggregate(spans)
  const totalMs = apps.reduce((sum, a) => sum + a.ms, 0)
  if (totalMs < 30 * 60_000) return null
  const lines = apps.slice(0, 10).map((a) => {
    const hours = (a.ms / 3_600_000).toFixed(1)
    return `- ${a.app} ${hours}h${a.topTitles.length > 0 ? ` — ${a.topTitles.join(' · ')}` : ''}`
  })
  return [
    `# Work log ${day}`,
    '',
    `Desk time ${(totalMs / 3_600_000).toFixed(1)}h across ${apps.length} apps (from the desk journal).`,
    '',
    ...lines,
  ].join('\n')
}

// What the chat reads when a temporal question lands: today's (and
// yesterday's) spans, folded per app with the longest-held titles.
export async function activitySummary(vault: VaultContext, days: number): Promise<string | null> {
  const spans: ActivitySpan[] = []
  for (let d = 0; d < Math.min(days, 7); d++) {
    spans.push(...(await readDaySpans(vault, Date.now() - d * 86_400_000)))
  }
  if (open && Date.now() - open.startedAt >= MIN_SPAN_MS) {
    spans.push({
      app: open.app,
      title: sanitizeTitle(open.title),
      start: new Date(open.startedAt).toISOString(),
      end: new Date().toISOString(),
    })
  }
  if (spans.length === 0) return null
  const clock = (iso: string): string => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const timeline = spans
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .slice(-24)
    .map((s) => `- ${s.start.slice(0, 10)} ${clock(s.start)}→${clock(s.end)} ${s.app}${s.title ? ` — ${s.title}` : ''}`)
  const totals = aggregate(spans)
    .slice(0, 8)
    .map((a) => `- ${a.app} ${(a.ms / 3_600_000).toFixed(1)}h${a.topTitles.length > 0 ? ` — ${a.topTitles.join(' · ')}` : ''}`)
  return [
    `--- Desk activity (foreground app spans, last ${Math.min(days, 7)}d — local activity journal; times are the user's local clock) ---`,
    'Timeline (recent spans):',
    ...timeline,
    'Totals:',
    ...totals,
  ].join('\n')
}
