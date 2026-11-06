const IN_FLIGHT = new Set(['designing', 'implementing', 'verifying'])

function prefix(glob) {
  const star = glob.indexOf('*')
  return star === -1 ? glob : glob.slice(0, star)
}

function pairOverlaps(a, b) {
  const literalA = !a.includes('*')
  const literalB = !b.includes('*')
  if (literalA && literalB) return a === b
  if (literalA) return a.startsWith(prefix(b))
  if (literalB) return b.startsWith(prefix(a))
  const pa = prefix(a)
  const pb = prefix(b)
  return pa.startsWith(pb) || pb.startsWith(pa)
}

export function overlaps(globsA, globsB) {
  return globsA.some((a) => globsB.some((b) => pairOverlaps(a, b)))
}

// The shared-file lock is implied: two items that both include a shared file always overlap.
export function runnable(items) {
  const busy = items.filter((item) => IN_FLIGHT.has(item.state))
  const ids = []
  for (const item of items) {
    if (item.state !== 'briefed') continue
    if (busy.some((other) => overlaps(item.allowedFiles, other.allowedFiles))) continue
    ids.push(item.id)
    busy.push(item)
  }
  return ids
}
