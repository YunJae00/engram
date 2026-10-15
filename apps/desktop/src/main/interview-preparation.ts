import { engineBackoff, engineCwd, prepareInitialFiling, readWorkMap } from 'core'
import { flog } from './flog.js'
import type { EngramEvent } from '../shared/types.js'
import { noteRunOutcome, revalidateEngines } from './engine-health.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'
import { verifySetupConnection } from './setup-connection.js'
import { primeWorkMap } from './work-map-job.js'
import { refreshDeskNotes, withheldDeskNotes } from './desk-sources.js'
import { setTimeout as pause } from 'node:timers/promises'

// Each filing call is mostly a runtime starting up and waiting on the model,
// so a few at once cut the first wait several times without crowding memory.
const COSMOS_PARALLEL = 4
// How long the work map gets to arrive before Cosmos goes ahead without it, and how often to look.
const MAP_WAIT_MS = 3 * 60_000
const MAP_POLL_MS = 5_000

export type InterviewProgress = Omit<Extract<EngramEvent, { type: 'interview:progress' }>, 'type' | 'requestId'>
export type PrepareInterview = (signal: AbortSignal, progress: (state: InterviewProgress) => void) => Promise<readonly string[]>

// Cancel waiting without cancelling a map refresh another surface may still need.
async function waitForMap(ctx: VaultContext, signal: AbortSignal, budget: number): Promise<void> {
  signal.throwIfAborted()
  let cancel: () => void = () => undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, budget)) })
  try { await Promise.race([primeWorkMap(ctx), canceled, deadline]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
  signal.throwIfAborted()
}

export async function prepareInterviewContext(ctx: VaultContext, signal: AbortSignal, progress: (state: InterviewProgress) => void): Promise<readonly string[]> {
  signal.throwIfAborted()
  progress({ phase: 'connection' })
  await revalidateEngines(ctx, false, false)
  signal.throwIfAborted()
  if (!ctx.engines.length) throw new Error('Connect an AI before preparing Cosmos.')
  const engine = ctx.engines[0]!
  if (engine.id === 'claude' || engine.id === 'codex') await verifySetupConnection(engine, engineCwd(ctx.paths), AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
  if (engineBackoff.blockedMs() > 0) throw new Error('Your AI is temporarily unavailable after a limited request. Retry later or test another model or AI in Settings.')
  // Right after setup the map may still be on its way (the brain was only
  // just detected, the browser only just read). It gets a bounded wait; past
  // that, Cosmos is prepared without it and the places join when it lands.
  let withMap = (await loadSettings()).workMap
  if (withMap) {
    progress({ phase: 'mapping' })
    for (const until = Date.now() + MAP_WAIT_MS; ; await pause(Math.min(MAP_POLL_MS, Math.max(0, until - Date.now())), undefined, { signal })) {
      await waitForMap(ctx, signal, until - Date.now())
      if (!(await loadSettings()).workMap) { withMap = false; break }
      if (process.env['ENGRAM_USERDATA']) break
      const map = await readWorkMap(ctx.paths)
      if (map && !(map.places.length > 0 && map.places.every(place => place.work === undefined))) break
      if (Date.now() >= until) { withMap = false; flog('work-map', 'Cosmos prepared without the work map; it was not ready in time'); break }
    }
  }
  await refreshDeskNotes(ctx)
  signal.throwIfAborted()
  const report = await prepareInitialFiling(ctx.paths, [engine], {
    signal, concurrency: COSMOS_PARALLEL, modelHint: 'fast', includeWorkMap: withMap, withheld: await withheldDeskNotes(),
    onProgress: (completed, total, stage) => progress({ phase: 'filing', stage, completed, total }),
  })
  signal.throwIfAborted()
  noteRunOutcome(ctx, report, engine)
  if (report.haltReason === 'auth') throw new Error('Reconnect your AI to finish preparing Cosmos.')
  if (report.haltReason === 'quota') throw new Error('Your AI limited a request. Completed work was kept. Reported account limits may differ. Retry later or test another model or AI in Settings.')
  if (report.failed.length || report.deferred) {
    flog('interview-preparation', `${report.failed.length} failed, ${report.deferred} deferred`)
    throw new Error('Cosmos preparation paused. Your progress is saved. Retry to continue.')
  }
  return report.noteIds
}
