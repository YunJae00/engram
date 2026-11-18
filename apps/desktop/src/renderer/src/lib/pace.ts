export function timeLeft(completed: number, total: number, pace: { at: number; from: number } | null, now = performance.now()): string {
  const done = completed - (pace?.from ?? completed)
  if (!pace || done < 2 || completed >= total) return ''
  const minutes = Math.round((now - pace.at) / done * (total - completed) / 60_000)
  return minutes < 1 ? ' · under a minute left' : ` · about ${minutes} min left`
}
