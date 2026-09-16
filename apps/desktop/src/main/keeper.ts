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
const TICK_MS = 6 * 60 * 60_000

interface KeeperState {
  gardenedAt?: number
  distilledAt?: number
  // The last day whose desk work log was written (YYYY-MM-DD).
  worklogDay?: string
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

async function tick(ctx: VaultContext): Promise<void> {
  const now = Date.now()
  const state = await readState()
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10)
  if (state.worklogDay !== yesterday && isActivityWatchEnabled()) {
    let log = ''
    let logged = true
    const dayStart = new Date(yesterday + 'T00:00:00Z').getTime()
    const trail = foldWebTrail(await readWebTrail(dayStart, dayStart + 86_400_000).catch(() => []))
    const files = await recentFileNames(dayStart, dayStart + 86_400_000).catch(() => [])
    if (trail.length > 0) log += `\n\n## Web\n${trail.join('\n')}`
    if (files.length > 0) log += `\n\n## Files touched\n${files.slice(0, 12).map((n) => `- ${n}`).join('\n')}`
    if (log) {
      // The day stamp only advances when the write landed — advancing on a
      // failed write discards that day's worklog permanently, since no later
      // tick retries a stamped day.
      logged = await writeCapture(ctx.paths.inbox, `# Browser and file activity ${yesterday} (UTC)${log}`).then(
        () => { runPipelineAsync(ctx, 'librarian: browser and file activity'); return true },
        (err) => {
          flog('worklog-write-failed', err)
          return false
        },
      )
    }
    if (logged) await writeState({ worklogDay: yesterday })
  }
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
    if (await captureDeskActivity(ctx)) runPipelineAsync(ctx, 'librarian: desk activity')
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
  activityTimer = setInterval(() => void fileActivity(ctx), SETTLE_MS)
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer)
  if (activityTimer) clearInterval(activityTimer)
  if (settling) clearTimeout(settling)
  timer = null
  activityTimer = null
  settling = null
}
