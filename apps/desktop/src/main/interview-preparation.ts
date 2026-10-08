import { engineBackoff, prepareInitialFiling, readWorkMap } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { noteRunOutcome } from './engine-health.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'
import { primeWorkMap } from './work-map-job.js'

export type InterviewProgress = Omit<Extract<EngramEvent, { type: 'interview:progress' }>, 'type' | 'requestId'>
export type PrepareInterview = (signal: AbortSignal, progress: (state: InterviewProgress) => void) => Promise<readonly string[]>

// Cancel waiting without cancelling a map refresh another surface may still need.
async function waitForMap(ctx: VaultContext, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let cancel: () => void = () => undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { await Promise.race([primeWorkMap(ctx), canceled]) }
  finally { signal.removeEventListener('abort', cancel) }
  signal.throwIfAborted()
}

export async function prepareInterviewContext(ctx: VaultContext, signal: AbortSignal, progress: (state: InterviewProgress) => void): Promise<readonly string[]> {
  signal.throwIfAborted()
  if (!ctx.engines.length) throw new Error('Connect an AI before preparing Cosmos.')
  if (engineBackoff.blockedMs() > 0) throw new Error('Your AI is temporarily unavailable. Retry later or start now.')
  if ((await loadSettings()).workMap) {
    progress({ phase: 'mapping' })
    await waitForMap(ctx, signal)
    if ((await loadSettings()).workMap && !process.env['ENGRAM_USERDATA']) {
      const map = await readWorkMap(ctx.paths)
      if (!map || (map.places.length > 0 && map.places.every(place => place.work === undefined))) throw new Error('Your work map is not ready yet. Retry or start now.')
    }
  }
  signal.throwIfAborted()
  const engine = ctx.engines[0]
  const report = await prepareInitialFiling(ctx.paths, ctx.engines, {
    signal, concurrency: 1, modelHint: 'fast', includeWorkMap: (await loadSettings()).workMap,
    onProgress: (completed, total, stage) => progress({ phase: 'filing', stage, completed, total }),
  })
  signal.throwIfAborted()
  noteRunOutcome(ctx, report, engine)
  if (report.haltReason === 'auth') throw new Error('Reconnect your AI to finish preparing Cosmos.')
  if (report.haltReason === 'quota') throw new Error('Your AI reached its usage limit. Completed work was kept; retry later or start now.')
  if (report.failed.length || report.deferred) throw new Error('Cosmos preparation is incomplete. Completed work was kept; retry or start now.')
  return report.noteIds
}
