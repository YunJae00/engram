import type { CardDto } from '../../../shared/types.js'

// One ISSUE = the connected component of pending cards sharing target notes.
// Judgment jobs raise several card types about the same pair; the user only
// ever answers one (siblings auto-dismiss on approval), so every surface
// should COUNT and LIST issues, not cards. Mirrors core's groupByTargetOverlap
// in jobs/librarian.ts (renderer cannot import core — keep in lockstep).
const TYPE_RANK = ['conflict', 'supersede', 'merge', 'stale', 'chronology', 'new-note']

interface Issue {
  lead: CardDto
  siblings: CardDto[] // other pending cards folded into this issue
}

export function groupIssues(cards: CardDto[]): Issue[] {
  const groups: { targets: Set<string>; cards: CardDto[] }[] = []
  for (const card of cards) {
    if (card.targets.length === 0) {
      groups.push({ targets: new Set(), cards: [card] })
      continue
    }
    const hits = groups.filter((g) => card.targets.some((t) => g.targets.has(t)))
    if (hits.length === 0) {
      groups.push({ targets: new Set(card.targets), cards: [card] })
      continue
    }
    const [head, ...rest] = hits
    head!.cards.push(card)
    for (const t of card.targets) head!.targets.add(t)
    for (const dead of rest) {
      head!.cards.push(...dead.cards)
      for (const t of dead.targets) head!.targets.add(t)
      groups.splice(groups.indexOf(dead), 1)
    }
  }
  return groups.map((g) => {
    const sorted = [...g.cards].sort(
      (a, b) => TYPE_RANK.indexOf(a.cardType) - TYPE_RANK.indexOf(b.cardType) || a.id.localeCompare(b.id),
    )
    return { lead: sorted[0]!, siblings: sorted.slice(1) }
  })
}

// Pending cards that will auto-dismiss when `card` is approved — used for
// honest feedback ("N related questions resolved with it").
export function overlapSiblings(card: CardDto, pending: CardDto[]): CardDto[] {
  if (card.targets.length === 0) return []
  const touched = new Set(card.targets)
  return pending.filter((c) => c.id !== card.id && c.targets.some((t) => touched.has(t)))
}
