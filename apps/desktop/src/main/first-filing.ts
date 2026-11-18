import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { engineBackoff, prepareInitialFiling, readWorkMap } from 'core'
import { flog } from './flog.js'
import { noteRunOutcome, revalidateEngines } from './engine-health.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'
import { primeWorkMap } from './work-map-job.js'
import { refreshDeskNotes, withheldDeskNotes } from './desk-sources.js'
import { firstSetupDone, reportFirstSetup } from './first-setup.js'

const COSMOS_PARALLEL = 4
const MAP_WAIT_MS = 3 * 60_000
const MAP_POLL_MS = 5_000
const RETRY_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]
const NO_AI_RETRY_MS = 5_000
const NO_AI = 'no AI is connected yet'
const MARKER = 'first-filing.json'

async function waitForMap(ctx: VaultContext, signal: AbortSignal, budget: number): Promise<boolean> {
  signal.throwIfAborted()
  let cancel: () => void = () => undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), Math.max(0, budget)) })
  const map = primeWorkMap(ctx).then(() => true, (error: unknown) => { flog('first-filing', `work map: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); return false })
  try { return await Promise.race([map, canceled, deadline]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); signal.throwIfAborted() }
}

async function fileOnce(ctx: VaultContext, signal: AbortSignal): Promise<void> {
  await revalidateEngines(ctx, false, false)
  signal.throwIfAborted()
  if (!ctx.engines.length) throw new Error(NO_AI)
  const engine = ctx.engines[0]!
  if (engineBackoff.blockedMs() > 0) throw new Error('the AI is resting after a limited request')
  let withMap = (await loadSettings()).workMap
  if (withMap) {
    reportFirstSetup({ phase: 'map' })
    for (const until = Date.now() + MAP_WAIT_MS; ; await pause(Math.min(MAP_POLL_MS, Math.max(0, until - Date.now())), undefined, { signal })) {
      if (!await waitForMap(ctx, signal, until - Date.now())) { withMap = false; flog('first-filing', 'Cosmos prepared without the work map; it could not be made'); break }
      if (!(await loadSettings()).workMap) { withMap = false; break }
      const map = await readWorkMap(ctx.paths)
      if (map && !(map.places.length > 0 && map.places.every(place => place.work === undefined))) break
      if (Date.now() >= until) { withMap = false; flog('first-filing', 'Cosmos prepared without the work map; it was not ready in time'); break }
    }
  }
  await refreshDeskNotes(ctx)
  signal.throwIfAborted()
  reportFirstSetup({ phase: 'filing', done: 0, total: 0 })
  const report = await prepareInitialFiling(ctx.paths, [engine], { signal, concurrency: COSMOS_PARALLEL, modelHint: 'fast', includeWorkMap: withMap, withheld: await withheldDeskNotes(), onProgress: (done, total, stage) => reportFirstSetup({ phase: 'filing', done, total, stage }) })
  signal.throwIfAborted()
  noteRunOutcome(ctx, report, engine)
  if (report.haltReason || report.failed.length || report.deferred) throw new Error(`paused (${report.haltReason ?? `${report.failed.length} failed, ${report.deferred} deferred`})`)
  flog('first-filing', `${report.noteIds.length} notes filed`)
}

export function startFirstFiling(ctx: VaultContext, exclusive: (signal: AbortSignal, run: () => Promise<void>) => Promise<void>, signal: AbortSignal, onFiled?: () => void): void {
  if (process.env['ENGRAM_USERDATA']) return
  const marker = join(ctx.paths.cache, MARKER)
  void (async () => {
    if (await readFile(marker, 'utf8').then(() => true, () => false)) return
    for (let attempt = 0; ; attempt++) {
      try {
        await exclusive(signal, () => fileOnce(ctx, signal))
        await writeFile(marker, JSON.stringify({ at: new Date().toISOString() }))
        await firstSetupDone(ctx)
        onFiled?.()
        return
      } catch (error) {
        if (signal.aborted) return
        const reason = error instanceof Error ? error.message : String(error)
        flog('first-filing', `will try again: ${reason}`)
        const wait = reason === NO_AI && attempt < 24 ? NO_AI_RETRY_MS : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!
        reportFirstSetup(reason === NO_AI ? { phase: 'ai' } : { phase: 'retrying', reason, retryAt: Date.now() + wait })
        await pause(wait, undefined, { signal }).catch(() => undefined)
        if (signal.aborted) return
      }
    }
  })()
}
