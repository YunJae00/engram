// The local brain is a fact, not a choice: with one model on the list it
// arrives by itself the first time the app is up with a network and room on
// disk, the way the embedder does, and the settings sheet only reports where
// it stands. A failed attempt is tried again once a day rather than every
// minute - a machine behind an inspecting proxy fails the same way every time,
// and a retry storm only buries the log.

export const RETRY_AFTER_MS = 24 * 3_600_000
// Not in the first seconds of a session: the window, the vault and the
// embedder are all starting, and the download is the one thing that can wait.
export const FIRST_TRY_DELAY_MS = 20_000
export const CHECK_EVERY_MS = 3_600_000

export interface FetchDeps {
  // The id of the model that should be on disk and is not, or null.
  missing(): Promise<string | null>
  download(id: string): Promise<{ ok: boolean; log?: string }>
  lastFailedAt(): Promise<number | null>
  noteFailure(at: number, log: string): Promise<void>
  now?(): number
}

export type FetchOutcome = 'present' | 'downloaded' | 'waiting' | 'failed'

export function retryDue(lastFailedAt: number | null, now: number): boolean {
  return lastFailedAt === null || now - lastFailedAt >= RETRY_AFTER_MS
}

export async function fetchIfMissing(deps: FetchDeps): Promise<FetchOutcome> {
  const id = await deps.missing()
  if (!id) return 'present'
  const now = deps.now?.() ?? Date.now()
  if (!retryDue(await deps.lastFailedAt(), now)) return 'waiting'
  const result = await deps.download(id)
  if (result.ok) return 'downloaded'
  // A cancel is the person's own hand, not a failure to wait a day on.
  if (result.log !== 'canceled') await deps.noteFailure(now, result.log ?? '')
  return 'failed'
}

// One attempt shortly after start, then an hourly look for a machine that
// came online later. Returns the disarm.
export function armAutoFetch(deps: FetchDeps): () => void {
  let running: Promise<FetchOutcome> | null = null
  const run = (): void => {
    if (running) return
    running = fetchIfMissing(deps).finally(() => {
      running = null
    })
  }
  const first = setTimeout(run, FIRST_TRY_DELAY_MS)
  const every = setInterval(run, CHECK_EVERY_MS)
  every.unref?.()
  first.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
