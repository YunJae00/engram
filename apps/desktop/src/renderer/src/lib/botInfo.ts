export const INSTRUCTIONS_SAVE_MS = 500
export const INSTRUCTIONS_MAX = 2000

export function capInstructions(text: string): string {
  const kept = text.slice(0, INSTRUCTIONS_MAX)
  const last = kept.charCodeAt(kept.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept
}

export function instructionsSaver(
  save: (botId: string, purpose: string) => Promise<unknown>,
  onError: (error: unknown) => void,
  delayMs = INSTRUCTIONS_SAVE_MS,
): { edit(botId: string, text: string): void; flush(): void } {
  let pending: { botId: string; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!pending) return
    const { botId, text } = pending
    pending = null
    try {
      void save(botId, text).catch(onError)
    } catch (error) {
      onError(error)
    }
  }
  return {
    edit(botId, text) {
      if (pending && pending.botId !== botId) flush()
      pending = { botId, text: capInstructions(text) }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
