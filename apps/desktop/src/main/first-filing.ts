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

// The first filing: what was gathered at setup - the work map's places, the
// desk notes, what sits in the inbox - organized into Cosmos once, in the
// background, so the first conversations already know the person's work.

// Each filing call is mostly a runtime starting up and waiting on the model,
// so a few at once cut the first wait several times without crowding memory.
const COSMOS_PARALLEL = 4
// How long the work map gets to arrive before Cosmos goes ahead without it, and how often to look.
const MAP_WAIT_MS = 3 * 60_000
const MAP_POLL_MS = 5_000
// A first filing that could not finish is tried again soon, then less often:
// what the first conversations know depends on it.
const RETRY_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]
const MARKER = 'first-filing.json'

// Cancel waiting without cancelling a map refresh another surface may still
// need. False when the map could not be made: then there is nothing to wait for.
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
  if (!ctx.engines.length) throw new Error('no AI is connected yet')
  const engine = ctx.engines[0]!
  // No separate connection check: one would compete with the conversations
  // already using the AI, and the filing's own calls say when it cannot answer.
  if (engineBackoff.blockedMs() > 0) throw new Error('the AI is resting after a limited request')
  // Right after setup the map may still be on its way. It gets a bounded
  // wait; past that, Cosmos is prepared without it and the places join later.
  let withMap = (await loadSettings()).workMap
  if (withMap) {
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
  const report = await prepareInitialFiling(ctx.paths, [engine], { signal, concurrency: COSMOS_PARALLEL, modelHint: 'fast', includeWorkMap: withMap, withheld: await withheldDeskNotes() })
  signal.throwIfAborted()
  noteRunOutcome(ctx, report, engine)
  if (report.haltReason || report.failed.length || report.deferred) throw new Error(`paused (${report.haltReason ?? `${report.failed.length} failed, ${report.deferred} deferred`})`)
  flog('first-filing', `${report.noteIds.length} notes filed`)
}

// Runs the first filing until it has finished once for this vault. The host
// passes its filing lock; a probe or test profile is left alone.
export function startFirstFiling(ctx: VaultContext, exclusive: (signal: AbortSignal, run: () => Promise<void>) => Promise<void>, signal: AbortSignal, onFiled?: () => void): void {
  if (process.env['ENGRAM_USERDATA']) return
  const marker = join(ctx.paths.cache, MARKER)
  void (async () => {
    if (await readFile(marker, 'utf8').then(() => true, () => false)) return
    for (let attempt = 0; ; attempt++) {
      try {
        await exclusive(signal, () => fileOnce(ctx, signal))
        await writeFile(marker, JSON.stringify({ at: new Date().toISOString() }))
        onFiled?.()
        return
      } catch (error) {
        if (signal.aborted) return
        flog('first-filing', `will try again: ${error instanceof Error ? error.message : String(error)}`)
        await pause(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!, undefined, { signal }).catch(() => undefined)
        if (signal.aborted) return
      }
    }
  })()
}
