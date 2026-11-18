// One kept-open voice answers one question at a time. Questions that arrive
// together - several conversations ending at once - wait their turn instead
// of failing, and the wait counts against each asker's own time.
export interface VoiceLike {
  readonly closed: boolean
  readonly ready: boolean
  ask(prompt: string, timeoutMs: number): Promise<string>
}

// stack-17 (R1/R2 in c17a's run: three helpers' item judges, asked together, came back at 5.0, 9.9 and 10.1 s, the last two too late
// to be used): one kept-open voice for the whole app put every quick answer in one line, so work meant to run side by side (GROKBOT
// rule 7) waited on itself. A question takes the least busy of `lanes` voices; each voice still answers one question at a time.
const tails: Promise<unknown>[] = []
const waiting: number[] = []

export function askInTurn(voice: (lane: number) => Promise<VoiceLike | undefined>, prompt: string, timeoutMs: number, lanes = 1): Promise<string> {
  const started = Date.now()
  let lane = 0
  for (let i = 1; i < lanes; i++) if ((waiting[i] ?? 0) < (waiting[lane] ?? 0)) lane = i
  waiting[lane] = (waiting[lane] ?? 0) + 1
  const mine = (tails[lane] ?? Promise.resolve()).then(async () => {
    const until = started + timeoutMs
    if (Date.now() >= until) throw new Error('The voice took too long.')
    const live = await voice(lane)
    if (!live) throw new Error('The voice is not ready.')
    // An answer given up on may still be coming; the next question waits it out.
    while (!live.ready) {
      if (live.closed || Date.now() >= until) throw new Error('The voice is not ready.')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return live.ask(prompt, until - Date.now())
  })
  tails[lane] = mine.catch(() => undefined).then(() => { waiting[lane]!-- })
  return mine
}
