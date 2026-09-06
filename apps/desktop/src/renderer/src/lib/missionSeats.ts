export type Seats = (string | null)[]

export function readSeats(raw: string | null): Seats {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    const seen = new Set<string>()
    return Array.from({ length: 4 }, (_, index) => {
      const id: unknown = Array.isArray(parsed) ? parsed[index] : null
      if (typeof id !== 'string' || !id || seen.has(id)) return null
      seen.add(id)
      return id
    })
  } catch { return [null, null, null, null] }
}

// Work finishing never changes a seat. New work only fills a vacant seat;
// only a deliberate replacement or a deleted chat removes its occupant.
export function fillSeats(previous: Seats, existing: string[], running: string[]): Seats {
  const next = previous.map((id) => id && existing.includes(id) ? id : null)
  for (const id of running) {
    const free = next.indexOf(null)
    if (free < 0) break
    if (existing.includes(id) && !next.includes(id)) next[free] = id
  }
  return next.every((id, index) => id === previous[index]) ? previous : next
}

export function replaceSeat(previous: Seats, index: number, id: string): Seats {
  const next = [...previous]
  const other = next.indexOf(id)
  if (other >= 0) next[other] = next[index] ?? null
  next[index] = id
  return next
}
