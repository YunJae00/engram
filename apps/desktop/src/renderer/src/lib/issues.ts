import type { CardDto } from '../../../shared/types.js'

const TYPE_RANK = ['conflict', 'supersede', 'merge', 'stale', 'chronology', 'new-note']

interface Issue {
  lead: CardDto
  siblings: CardDto[]
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

export function overlapSiblings(card: CardDto, pending: CardDto[]): CardDto[] {
  if (card.targets.length === 0) return []
  const touched = new Set(card.targets)
  return pending.filter((c) => c.id !== card.id && c.targets.some((t) => touched.has(t)))
}
