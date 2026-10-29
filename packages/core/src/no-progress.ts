// A turn that keeps getting back what it already saw is going around, not
// working. After enough of those in a row it is told to take another way; a call that brings anything new resets the count. The
// same count lets a turn that is still finding things go past its allowance.
export const NO_PROGRESS_LIMIT = 8

export interface ProgressWatch {
  // The note for the brain when it has gone around too long, else null.
  see(observation: string): string | null
  // Calls in a row that brought nothing new.
  idle(): number
}

export function progressWatch(limit = NO_PROGRESS_LIMIT): ProgressWatch {
  const seen = new Set<string>()
  let stale = 0, run = 0
  return {
    see(observation) {
      const key = observation.replace(/\s+/g, ' ').trim()
      // A call that did not work found nothing, whatever its error says.
      const failed = key.startsWith('that did not work')
      if (!failed && !seen.has(key)) { seen.add(key); stale = 0; run = 0; return null }
      stale += 1; run += 1
      if (stale < limit) return null
      stale = 0
      return `The last ${limit} calls brought back nothing new. Stop going around and take a clearly different way: another control, page, address or source. Ask the person only for what only they can give.`
    },
    idle: () => run,
  }
}
