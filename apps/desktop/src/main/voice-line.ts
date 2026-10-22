// One kept-open voice answers one question at a time. Questions that arrive
// together - several conversations ending at once - wait their turn instead
// of failing, and the wait counts against each asker's own time.
export interface VoiceLike {
  readonly closed: boolean
  readonly ready: boolean
  ask(prompt: string, timeoutMs: number): Promise<string>
}

let tail: Promise<unknown> = Promise.resolve()

export function askInTurn(voice: () => Promise<VoiceLike | undefined>, prompt: string, timeoutMs: number): Promise<string> {
  const started = Date.now()
  const mine = tail.then(async () => {
    const until = started + timeoutMs
    if (Date.now() >= until) throw new Error('The voice took too long.')
    const live = await voice()
    if (!live) throw new Error('The voice is not ready.')
    // An answer given up on may still be coming; the next question waits it out.
    while (!live.ready) {
      if (live.closed || Date.now() >= until) throw new Error('The voice is not ready.')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return live.ask(prompt, until - Date.now())
  })
  tail = mine.catch(() => undefined)
  return mine
}
