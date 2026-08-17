import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  distillPrompt,
  ENGINE_BUDGETS,
  engineBackoff,
  engineCwd,
  extractJson,
  installSkill,
  readSkillsLedger,
  skillCandidates,
  sweepGarden,
  type Engine,
  type SkillCandidate,
  type SkillDraft,
} from 'core'
import { writeCapture } from 'core'
import { app } from 'electron'
import { composeWorklog, readDaySpans } from './activity-watch.js'
import { flog } from './flog.js'
import { foldWebTrail, readWebTrail, recentFileNames } from './web-trail.js'
import type { VaultContext } from './vault.js'

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

// The engine either refuses ({"skip": true}) or answers structurally —
// anything else (prose, half-JSON, empty) reads as a refusal. No slop.
function parseDraft(raw: string | null): SkillDraft | null {
  if (!raw) return null
  try {
    const value = extractJson(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    if (value['skip'] === true) return null
    const title = value['title']
    const description = value['description']
    const body = value['body']
    if (typeof title !== 'string' || typeof description !== 'string' || typeof body !== 'string') return null
    if (!title.trim() || !description.trim() || body.trim().length < 100) return null
    return { title, description, body }
  } catch {
    return null
  }
}

async function distillOnce(ctx: VaultContext, candidate: SkillCandidate): Promise<void> {
  const engine = ctx.engines[0]
  if (!engine) return
  const raw = await collectResult(engine, distillPrompt(candidate), engineCwd(ctx.paths)).catch(() => null)
  const draft = parseDraft(raw)
  if (!draft) {
    flog('skill-distill', `${candidate.slug}: engine declined (gate)`)
    return
  }
  const result = await installSkill(homedir(), ctx.paths, candidate, draft)
  flog('skill-distill', `${candidate.slug}: ${result.installed ? 'installed' : (result.reason ?? 'skipped')}`)
}

async function tick(ctx: VaultContext): Promise<void> {
  const now = Date.now()
  const state = await readState()
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10)
  if (state.worklogDay !== yesterday) {
    const spans = await readDaySpans(ctx, now - 86_400_000).catch(() => [])
    let log = composeWorklog(yesterday, spans)
    let logged = true
    if (log) {
      // The web trail and recent documents join the day's note (PLAN-LOCAL-
      // FIRST §3.5): in the webmail era the browser's page titles are often
      // the only on-device record of what the office day was about.
      const dayStart = new Date(yesterday + 'T00:00:00').getTime()
      const trail = foldWebTrail(await readWebTrail(dayStart).catch(() => []))
      const files = await recentFileNames(dayStart).catch(() => [])
      if (trail.length > 0) log += `\n\n## Web\n${trail.join('\n')}`
      if (files.length > 0) log += `\n\n## Files touched\n${files.slice(0, 12).map((n) => `- ${n}`).join('\n')}`
      // The day stamp only advances when the write landed — advancing on a
      // failed write discards that day's worklog permanently, since no later
      // tick retries a stamped day.
      logged = await writeCapture(ctx.paths.inbox, log).then(
        () => true,
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
  // weekly stamp only advances when a pass actually ran.
  if (now - (state.distilledAt ?? 0) >= WEEK_MS && ctx.engines.length > 0 && engineBackoff.blockedMs() === 0) {
    const ledger = await readSkillsLedger(ctx.paths)
    const candidates = skillCandidates(ctx.store.getAll(), ledger)
    for (const candidate of candidates) await distillOnce(ctx, candidate).catch(() => undefined)
    await writeState({ distilledAt: now })
  }
}

let timer: NodeJS.Timeout | null = null

export function startKeeper(ctx: VaultContext): void {
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  if (timer) clearInterval(timer)
  setTimeout(() => void tick(ctx), SETTLE_MS)
  timer = setInterval(() => void tick(ctx), TICK_MS)
}

export function stopKeeper(): void {
  if (timer) clearInterval(timer)
  timer = null
}
