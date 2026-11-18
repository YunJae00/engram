import {
  engineBackoff,
  type Engine,
  type EngineErrorKind,
  type RunReport,
} from 'core'
import { BrowserWindow } from 'electron'
import type { EngineHealthDto, EngineHealthReason, EngineStatusDto, EngramEvent } from '../shared/types.js'
import type { VaultContext } from './vault.js'
import { overlayWindowIds } from './desktop-overlay.js'
import { activeAccountProfile } from './account-profiles.js'
import { flog } from './flog.js'
import { cloudEngine } from './engine-cloud.js'

function selectedAccount(engine: Engine | undefined): boolean {
  if (!engine || (engine.id !== 'claude' && engine.id !== 'codex')) return true
  const profile = (engine as Engine & { accountProfile?: string }).accountProfile
  return profile === undefined || profile === activeAccountProfile(engine.id)
}

function toReason(kind: EngineErrorKind): EngineHealthReason {
  return kind
}

const taps = new Set<(event: EngramEvent) => void>()
export function tapBroadcast(tap: (event: EngramEvent) => void): () => void { taps.add(tap); return () => { taps.delete(tap) } }

export function broadcast(event: EngramEvent): void {
  for (const tap of taps) tap(event)
  const overlays = overlayWindowIds()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!overlays.includes(win.webContents.id)) win.webContents.send('engram:event', event)
  }
}

const engineHealth = new Map<string, EngineHealthDto>()
function healthKey(id: string, profile?: string): string {
  return id === 'claude' || id === 'codex' ? `${id}:${profile ?? activeAccountProfile(id)}` : id
}

export function engineHealthOf(id: string, profile?: string): EngineHealthDto | undefined {
  return engineHealth.get(healthKey(id, profile))
}

const failStreak = new Map<string, number>()
const CONFIRM_AFTER = 2

function setHealth(id: string, next: EngineHealthDto, profile?: string): void {
  const key = healthKey(id, profile)
  if (!next.healthy && next.reason === 'auth' && (id === 'claude' || id === 'codex')) cloudEngine(id, profile).forgetStatus?.()
  const prev = engineHealth.get(key)
  if (prev && prev.healthy === next.healthy && prev.reason === next.reason) return
  engineHealth.set(key, next)
  if (key === healthKey(id)) broadcast({ type: 'engine:health', id, healthy: next.healthy, reason: next.reason })
}

export function markEngineOk(id: string, profile?: string): void {
  if (id === 'claude' || id === 'codex') cloudEngine(id, profile).confirmAuth?.()
  failStreak.set(healthKey(id, profile), 0)
  setHealth(id, { healthy: true }, profile)
}

const QUOTA_RESUME_FLOOR_MS = 60_000
const QUOTA_RESUME_DEFAULT_MS = 5 * 60_000
let quotaResumeTimer: NodeJS.Timeout | null = null
let quotaResumeAt = 0

function scheduleQuotaResume(ctx: VaultContext, delayMs: number): void {
  const wait = Math.max(QUOTA_RESUME_FLOOR_MS, delayMs)
  const at = Date.now() + wait
  if (quotaResumeTimer !== null && at >= quotaResumeAt) return
  if (quotaResumeTimer !== null) clearTimeout(quotaResumeTimer)
  quotaResumeAt = at
  quotaResumeTimer = setTimeout(() => {
    quotaResumeTimer = null
    void revalidateEngines(ctx)
  }, wait)
}

export function noteRunOutcome(ctx: VaultContext, report: RunReport, engine = ctx.engines[0]): void {
  if (!selectedAccount(engine)) return
  const id = engine?.id
  if (!id) return
  if (report.haltReason) {
    setHealth(id, { healthy: false, reason: report.haltReason })
    if (report.haltReason === 'auth') void revalidateEngines(ctx)
    if (report.haltReason === 'outage') {
      engineBackoff.noteOutage()
      scheduleQuotaResume(ctx, engineBackoff.blockedMs())
    }
    if (report.haltReason === 'quota') {
      engineBackoff.noteQuota(report.quotaRetryAfterMs)
      scheduleQuotaResume(ctx, engineBackoff.blockedMs() || QUOTA_RESUME_DEFAULT_MS)
    }
  } else if (report.executed > 0) {
    engineBackoff.noteOk()
    markEngineOk(id)
  }
}

export async function noteEngineFailure(engine: Engine, kind: EngineErrorKind, ctx?: VaultContext): Promise<void> {
  if (!selectedAccount(engine)) return
  if (kind === 'quota') {
    setHealth(engine.id, { healthy: false, reason: 'quota' })
    engineBackoff.noteQuota()
    if (ctx) scheduleQuotaResume(ctx, engineBackoff.blockedMs() || QUOTA_RESUME_DEFAULT_MS)
    return
  }
  if (kind === 'outage') {
    setHealth(engine.id, { healthy: false, reason: 'outage' })
    engineBackoff.noteOutage()
    if (ctx) scheduleQuotaResume(ctx, engineBackoff.blockedMs())
    return
  }
  if (kind === 'auth') {
    setHealth(engine.id, { healthy: false, reason: 'auth' })
    if (ctx) void revalidateEngines(ctx)
    return
  }
  const key = healthKey(engine.id)
  const streak = (failStreak.get(key) ?? 0) + 1
  failStreak.set(key, streak)
  if (streak >= CONFIRM_AFTER) setHealth(engine.id, { healthy: false, reason: toReason(kind) })
}


const AUTH_RECHECK_MS = 30 * 60_000
let watchTimer: NodeJS.Timeout | null = null

export function startEngineWatch(ctx: VaultContext): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(() => {
    void revalidateEngines(ctx)
  }, AUTH_RECHECK_MS)
}

export async function revalidateEngines(ctx: VaultContext, selectionOnly = false, notifyUnchanged = true): Promise<void> {
  try {
    const previous = selectionOnly || !notifyUnchanged ? JSON.stringify(ctx.engines.map(engineDto)) : null
    const wasReady = ctx.engines.length > 0
    const { refreshEngines } = await import('./vault.js')
    const engines = await refreshEngines(ctx, selectionOnly)
    if (!wasReady && engines.length) void import('./work-map-job.js').then(({ primeWorkMap }) => primeWorkMap(ctx)).catch(error => flog('work-map', error))
    const next = engines.map(engineDto)
    if (previous === JSON.stringify(next)) return
    broadcast({ type: 'engines:changed', engines: next })
  } catch {
  }
}

export function engineDto(engine: Engine): EngineStatusDto {
  const health = engineHealthOf(engine.id)
  return {
    id: engine.id,
    installed: true,
    loggedIn: true,
    ...((engine as Engine & { authConfirmed?: boolean }).authConfirmed === false && !health?.healthy ? { conclusive: false } : {}),
    desktopToolIsolation: engine.desktopToolIsolation === true,
    ...(health ? { healthy: health.healthy, ...(health.reason ? { healthReason: health.reason } : {}) } : {}),
  }
}
