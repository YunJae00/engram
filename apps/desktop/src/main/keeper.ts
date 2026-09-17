import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  distillPrompt,
  ENGINE_BUDGETS,
  engineBackoff,
  engineCwd,
  parseSkillDraft,
  installSkill,
  migrateSkillsHome,
  readSkillsLedger,
  skillCandidates,
  sweepGarden,
  type Engine,
  type SkillCandidate,
} from 'core'
import { writeCapture } from 'core'
import { app } from 'electron'
import { isActivityWatchEnabled } from './activity-watch.js'
import { flog } from './flog.js'
import { foldWebTrail, readWebTrail, recentFileNames } from './web-trail.js'
import type { VaultContext } from './vault.js'
import { captureDeskActivity } from './activity-capture.js'
import { runPipelineAsync } from './ipc.js'

const WEEK_MS = 7 * 86_400_000
const SETTLE_MS = 5 * 60_000
const HOUR_MS = 60 * 60_000
const TICK_MS = 6 * 60 * 60_000

interface KeeperState {
  gardenedAt?: number
  distilledAt?: number
  // High-water mark (epoch ms) of the browser+file work journal: the next
  // hourly pass logs only what happened after it.
  worklogThrough?: number
}

function stateFile(): string {
  return join(app.getPath('userData'), 'keeper-state.json')
}

async function readState(): Promise<KeeperState> {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8')) as KeeperState
  } catch {
    return {}
  }
}

async function writeState(patch: Partial<KeeperState>): Promise<void> {
  const next = { ...(await readState()), ...patch }
  await writeFile(stateFile(), JSON.stringify(next)).catch(() => undefined)
}

async function collectResult(engine: Engine, prompt: string, workdir: ReturnType<typeof engineCwd>): Promise<string | null> {
  let streamed = ''
  let finalText: string | null = null
  for await (const event of engine.run({
    prompt,
    workdir,
    disallowTools: true,
    modelHint: 'smart',
    timeoutMs: ENGINE_BUDGETS.job,
  })) {
    if (event.type === 'token') streamed += event.text
    else if (event.type === 'result') finalText = event.text
    else if (event.type === 'error') return null
  }
  return finalText ?? (streamed || null)
}

async function distillOnce(ctx: VaultContext, candidate: SkillCandidate): Promise<void> {
  const engine = ctx.engines[0]
  if (!engine) return
  const raw = await collectResult(engine, distillPrompt(candidate), engineCwd(ctx.paths)).catch(() => null)
  const draft = parseSkillDraft(raw)
  if (!draft) {
    flog('skill-distill', `${candidate.slug}: engine declined (gate)`)
    return
  }
  const result = await installSkill(ctx.paths, candidate, draft)
  flog('skill-distill', `${candidate.slug}: ${result.installed ? 'installed' : (result.reason ?? 'skipped')}`)
}

// The browser + file half of the hourly work journal. Cursor-based (worklogThrough)
// so each pass logs only the freshly elapsed window; the desk-app half is
// captureDeskActivity. Returns whether anything was written.
async function captureWebAndFiles(ctx: VaultContext, now = Date.now()): Promise<boolean> {
  if (!isActivityWatchEnabled()) return false
  const state = await readState()
  const until = now - 5 * 60_000
  // First run (or a long gap) backfills at most a day, never the whole history.
  const since = Math.max(state.worklogThrough ?? 0, until - 86_400_000)
  if (until <= since) return false
  const trail = foldWebTrail(await readWebTrail(since, until).catch(() => []))
  const files = await recentFileNames(since, until).catch(() => [])
  let log = ''
  if (trail.length > 0) log += `\n\n## Web\n${trail.join('\n')}`
  if (files.length > 0) log += `\n\n## Files touched\n${files.slice(0, 12).map((n) => `- ${n}`).join('\n')}`
  let wrote = false
  if (log) {
    const label = `${new Date(since).toLocaleString('en-GB')} – ${new Date(until).toLocaleString('en-GB')}`
    wrote = await writeCapture(ctx.paths.inbox, `# Browser and file activity ${label}${log}`).then(
      () => true,
      (err) => { flog('worklog-write-failed', err); return false },
    )
  }
  // Advance only when the write landed (or there was nothing to write); a failed
  // write keeps the cursor so the window is retried next hour rather than lost.
  if (wrote || !log) await writeState({ worklogThrough: until })
  return wrote
}

async function tick(ctx: VaultContext): Promise<void> {
  const now = Date.now()
  const state = await readState()
  if (now - (state.gardenedAt ?? 0) >= WEEK_MS) {
    const events = await sweepGarden(ctx.paths, ctx.store.getAll()).catch(() => [])
    if (events.length > 0) flog('gardener', `${events.length} note(s) shelved`)
    await writeState({ gardenedAt: now })
  }
  // Engine work is opportunistic: absent or quota-gated → try next tick, the
  // refresh stamp only advances when a pass actually ran.
  if (now - (state.distilledAt ?? 0) >= TICK_MS && ctx.engines.length > 0 && engineBackoff.blockedMs() === 0) {
    const ledger = await readSkillsLedger(ctx.paths)
    const candidates = skillCandidates(ctx.store.getAll(), ledger)
    for (const candidate of candidates) await distillOnce(ctx, candidate).catch(() => undefined)
    await writeState({ distilledAt: now })
  }
}

let timer: NodeJS.Timeout | null = null
let activityTimer: NodeJS.Timeout | null = null
let settling: NodeJS.Timeout | null = null
let capturing = false

async function fileActivity(ctx: VaultContext): Promise<void> {
  if (capturing) return
  capturing = true
  try {
    // Both halves of the hourly work journal: desk-app spans and the browser +
    // file trail. Either producing a capture wakes the librarian once.
    const desk = await captureDeskActivity(ctx)
    const web = await captureWebAndFiles(ctx)
    if (desk || web) runPipelineAsync(ctx, 'librarian: work journal')
  } catch (error) { flog('activity-capture-failed', error) }
  finally { capturing = false }
}

export function startKeeper(ctx: VaultContext): void {
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  stopKeeper()
  // Preserve legacy sources while importing this vault's recorded skills.
  void migrateSkillsHome(homedir(), ctx.paths)
    .then((moved) => { if (moved > 0) flog('skill-distill', `migrated ${moved} skill(s) into the vault`) })
    .catch(() => flog('skill-distill', 'Skill import failed; legacy files were preserved.'))
  const maintain = () => { void tick(ctx).catch(error => flog('keeper-failed', error)) }
  settling = setTimeout(() => { maintain(); void fileActivity(ctx) }, SETTLE_MS)
  timer = setInterval(maintain, TICK_MS)
  activityTimer = setInterval(() => void fileActivity(ctx), HOUR_MS)
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer)
  if (activityTimer) clearInterval(activityTimer)
  if (settling) clearTimeout(settling)
  timer = null
  activityTimer = null
  settling = null
}
