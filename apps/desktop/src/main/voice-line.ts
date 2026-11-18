export interface VoiceLike {
  readonly closed: boolean
  readonly ready: boolean
  ask(prompt: string, timeoutMs: number): Promise<string>
}

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
    while (!live.ready) {
      if (live.closed || Date.now() >= until) throw new Error('The voice is not ready.')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return live.ask(prompt, until - Date.now())
  })
  tails[lane] = mine.catch(() => undefined).then(() => { waiting[lane]!-- })
  return mine
}
