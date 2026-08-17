import {
  collectResult,
  ENGINE_BUDGETS,
  engineBackoff,
  engineCwd,
  EngineCallError,
  resetClaudeAuthCache,
  type Engine,
  type EngineErrorKind,
  type RunReport,
} from 'core'
import { BrowserWindow } from 'electron'
import type { EngineHealthDto, EngineHealthReason, EngineStatusDto, EngramEvent } from '../shared/types.js'
import type { VaultContext } from './vault.js'

// Assigning core's EngineErrorKind into the DTO union is the tripwire: a new
// kind in core stops compiling here instead of shipping a health state that
// renders as nothing at all.
function toReason(kind: EngineErrorKind): EngineHealthReason {
  return kind
}

// Everything the app knows about whether the engine is actually usable, in one
// place — because the old answer was scattered across a file check, a boot-only
// ping and a length test on an array, and all three could disagree while the
// top bar showed a green dot.

export function broadcast(event: EngramEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', event)
}

const engineHealth = new Map<string, EngineHealthDto>()

// Read by the diagnostics handler, which lives in another module and must
// answer with the SAME verdict the banner is showing — two screens disagreeing
// about the engine is the state that leaves a user with nothing to do.
export function engineHealthOf(id: string): EngineHealthDto | undefined {
  return engineHealth.get(id)
}

// Consecutive unconfirmed failures per engine. A single blip must not raise a
// banner: banners that cry wolf are how people learn to ignore the real one.
const failStreak = new Map<string, number>()
const CONFIRM_AFTER = 2

// Broadcast ONLY on a real change, so a 10-minute re-verification that finds
// everything fine is silent and the renderer's state never churns.
function setHealth(id: string, next: EngineHealthDto): void {
  // A confirmed auth failure must also drop the adapter's 60s positive auth
  // cache. Otherwise the very next re-detect (the Diagnostics 4s poll, window
  // focus) would answer from that stale positive and CLEAR the banner we just
  // raised — the app would go back to claiming everything is fine.
  if (!next.healthy && next.reason === 'auth') resetClaudeAuthCache()
  const prev = engineHealth.get(id)
  if (prev && prev.healthy === next.healthy && prev.reason === next.reason) return
  engineHealth.set(id, next)
  broadcast({ type: 'engine:health', id, healthy: next.healthy, reason: next.reason })
}

export function markEngineOk(id: string): void {
  failStreak.set(id, 0)
  setHealth(id, { healthy: true })
}

// For hosts that learn about a failure OUTSIDE a call path — the local
// inference worker dying on load, for one. Detection counts the model file
// as installed and pings exempt 'local', so this is the only way a broken
// worker surfaces before the first question fails.
export function markEngineUnhealthy(id: string, reason: EngineHealthReason): void {
  setHealth(id, { healthy: false, reason })
}

const QUOTA_RESUME_FLOOR_MS = 60_000
const QUOTA_RESUME_DEFAULT_MS = 5 * 60_000
let quotaResumeTimer: NodeJS.Timeout | null = null
let quotaResumeAt = 0

export function scheduleQuotaResume(ctx: VaultContext, delayMs: number): void {
  const wait = Math.max(QUOTA_RESUME_FLOOR_MS, delayMs)
  const at = Date.now() + wait
  if (quotaResumeTimer !== null && at >= quotaResumeAt) return
  if (quotaResumeTimer !== null) clearTimeout(quotaResumeTimer)
  quotaResumeAt = at
  quotaResumeTimer = setTimeout(() => {
    quotaResumeTimer = null
    void pingEngines(ctx)
  }, wait)
}

// A run finished: say what it implies about the engine. One function so all
// four librarian entry points (capture pipeline, auto-tidy, manual sweep, tray
// sweep) agree instead of each drawing its own conclusion.
export function noteRunOutcome(ctx: VaultContext, report: RunReport): void {
  const id = ctx.engines[0]?.id
  if (!id) return
  if (report.haltReason) {
    setHealth(id, { healthy: false, reason: report.haltReason })
    // An auth halt is the app's freshest evidence that the login is gone.
    // Re-detect so ctx.engines stops carrying an engine nothing can use — the
    // shell then falls back to the honest "installed, just log in" banner.
    if (report.haltReason === 'auth') void revalidateEngines(ctx)
    if (report.haltReason === 'quota') {
      // The DESKTOP owns the shared gate (a core-level gate blocked the
      // substitute engine and leaked across runs — reverted). Arm it with the
      // CLI's own retry-after when the run carried one, then schedule the
      // wake-up that decides when waiting is over.
      engineBackoff.noteQuota(report.quotaRetryAfterMs)
      scheduleQuotaResume(ctx, engineBackoff.blockedMs() || QUOTA_RESUME_DEFAULT_MS)
    }
  } else if (report.executed > 0) {
    engineBackoff.noteOk()
    markEngineOk(id)
  }
}

// Ask the CLI itself. `verifyAuth` returns null when it could not be asked
// (older CLI, spawn failure) — that is NOT a logout, so the last known state
// stands rather than a failure being invented.
async function askAuth(engine: Engine): Promise<boolean | null> {
  try {
    return (await engine.verifyAuth?.()) ?? null
  } catch {
    return null
  }
}

// A call failed. Decide whether that deserves a banner.
//   quota → yes, immediately: the message is specific and the remedy is "wait".
//   auth  → yes, but only once the CLI confirms the login is really gone.
//   other → the CLI's auth verdict gets first say; failing that, a SECOND
//           consecutive failure is needed before we accuse anything.
export async function noteEngineFailure(engine: Engine, kind: EngineErrorKind, ctx?: VaultContext): Promise<void> {
  if (kind === 'quota') {
    setHealth(engine.id, { healthy: false, reason: 'quota' })
    // A chat/ping 429 is evidence too: arm the gate so the next sweep waits,
    // and schedule the wake-up when the caller brought a ctx.
    engineBackoff.noteQuota()
    if (ctx) scheduleQuotaResume(ctx, engineBackoff.blockedMs() || QUOTA_RESUME_DEFAULT_MS)
    return
  }
  if ((await askAuth(engine)) === false) {
    setHealth(engine.id, { healthy: false, reason: 'auth' })
    return
  }
  if (kind === 'auth') {
    // The CLI says the login is fine (or could not be asked) but the call came
    // back with an auth error — believe the call, it is the more recent fact.
    setHealth(engine.id, { healthy: false, reason: 'auth' })
    return
  }
  const streak = (failStreak.get(engine.id) ?? 0) + 1
  failStreak.set(engine.id, streak)
  if (streak >= CONFIRM_AFTER) setHealth(engine.id, { healthy: false, reason: toReason(kind) })
}

export async function pingEngines(ctx: VaultContext): Promise<void> {
  await Promise.all(
    ctx.engines.map(async (engine) => {
      // The local brain is exempt: a ping would LOAD the whole model (tens of
      // seconds, gigabytes of RAM) to prove what detect() already proved with
      // a file stat. Presence of the model file IS its health.
      if (engine.id === 'local') return
      try {
        const reply = await collectResult(engine, {
          prompt: 'Reply with exactly: ok',
          workdir: engineCwd(ctx.paths),
          disallowTools: true,
          timeoutMs: ENGINE_BUDGETS.ping,
          modelHint: 'fast',
        })
        if (reply.trim().length > 0) markEngineOk(engine.id)
        else await noteEngineFailure(engine, 'crash', ctx)
      } catch (err) {
        await noteEngineFailure(engine, err instanceof EngineCallError ? err.kind : 'unknown', ctx)
      }
      broadcast({ type: 'vault:changed' })
    }),
  )
}

const AUTH_RECHECK_MS = 30 * 60_000
let watchTimer: NodeJS.Timeout | null = null

export function startEngineWatch(ctx: VaultContext): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(() => {
    void verifyEngineAuth(ctx).then(() => revalidateEngines(ctx))
  }, AUTH_RECHECK_MS)
}

export async function verifyEngineAuth(ctx: VaultContext): Promise<void> {
  for (const engine of ctx.engines) {
    const verdict = await askAuth(engine)
    if (verdict === false) setHealth(engine.id, { healthy: false, reason: 'auth' })
    // A good login does not clear a quota — that one lifts when the limit
    // resets, which the next successful run reports (noteRunOutcome).
    else if (verdict === true && engineHealth.get(engine.id)?.reason !== 'quota') markEngineOk(engine.id)
    // null = could not ask. Leave the last known state exactly as it was.
  }
}

// After a re-detection: membership in ctx.engines now MEANS the CLI itself said
// it is logged in (at most 60s stale — see ClaudeAdapter's auth cache), so an
// 'auth' verdict that survives a successful re-detect is out of date. Clearing
// it here is what makes the banner self-clearing through the paths that already
// re-detect (the Diagnostics 4s poll, window focus) at zero extra subprocess
// cost — the old banner was set once at boot and could never come down, so a
// user who fixed the problem kept being told it was still broken.
export function refreshHealthFromDetection(ctx: VaultContext): void {
  for (const engine of ctx.engines) {
    const health = engineHealth.get(engine.id)
    if (health?.healthy === false && health.reason === 'auth') markEngineOk(engine.id)
  }
}

// Re-detect engines and tell every window. UNCONDITIONALLY: this used to
// compare the engine-id SET before and after and stay silent when it matched —
// which, with file-based detection, is every single expiry, i.e. the exact
// failure the function was written to catch. The renderer's setEngines is
// idempotent and the payload is three fields, so there is nothing to save.
export async function revalidateEngines(ctx: VaultContext): Promise<void> {
  try {
    const { refreshEngines } = await import('./vault.js')
    const engines = await refreshEngines(ctx)
    broadcast({ type: 'engines:changed', engines: engines.map(engineDto) })
  } catch {
    /* detection is best-effort — never let it throw into a caller's error path */
  }
}

// Membership in ctx.engines now means "probed installed AND the CLI itself says
// logged in" (detectAvailableEngines gates on both), so these two are measured,
// not asserted. `healthy` carries the live ping/auth verdict so a renderer that
// just reloaded does not start out painting a green dot over a dead engine.
export function engineDto(engine: Engine): EngineStatusDto {
  const health = engineHealth.get(engine.id)
  return {
    id: engine.id,
    installed: true,
    loggedIn: true,
    ...(health ? { healthy: health.healthy, ...(health.reason ? { healthReason: health.reason } : {}) } : {}),
  }
}
