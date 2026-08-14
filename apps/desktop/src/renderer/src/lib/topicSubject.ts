
interface TopicGroup {
  ids: string[]
  // The shared subject that justified a merge — the word a person would use for
  // the combined pile, and therefore the name it must be relabelled with.
  // null when this topic is one community exactly as the graph found it.
  subject: string | null
}

// Ticket-shaped tokens ("SATURN-244", "[ENG-12]") are identifiers, not subject
// words — a cluster of tickets shares its project prefix by accident.
const TICKET_RE = /^\[?[A-Z]+-\d+\]?$/
const NUMBER_RE = /^\d+$/
// Wrapping punctuation/symbols come off token edges ("[SATURN-244]" →
// "SATURN-244", "'quotes'" → "quotes") but intra-token hyphens survive so the
// ticket filter still sees its shape.
const EDGE_TRIM_RE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

// The meaningful words of a title, in order. Shared with the topic labeller so
// a subject and a label are always read off the same tokens.
export function titleTokens(title: string): string[] {
  return title
    .split(/\s+/)
    .map((raw) => raw.replace(EDGE_TRIM_RE, ''))
    .filter((token) => token.length >= 2 && !TICKET_RE.test(token) && !NUMBER_RE.test(token))
}

// Share of a community's titles a word must carry before it is what that
// community is ABOUT rather than something it mentions. MyClientology carries
// 17 of 22 titles in the big cluster (0.77) and 9 of 9 in the small one.
const DOMINANT_SHARE = 0.6
// ...and it must carry at least two titles: one title is a coincidence.
const MIN_SUBJECT_TITLES = 2
const MAX_SUBJECT_COMMUNITIES = 2

// Merge the communities that a person would call one topic, and say what the
// merged topic is about.
//
// Two communities merge on a term only when all three hold:
//   1. the term is dominant in BOTH (it is what each pile is about),
//   2. the term appears in NO other community (it is distinctive, not a prefix),
//   3. the link graph already joins them (an edge exists between the two).
// (3) matters because communities come from different connected components too:
// without it, two piles that never cite each other would fuse on a shared word
// alone.
//
// Merging is transitive through union-find — {A,B} on one term and {B,C} on
// another gives one topic — because each edge had to earn itself separately.
// Deterministic throughout: terms are considered in sorted order and every tie
// keeps the first.
// MIRRORS SubjectKnowledge in packages/core/src/jobs/subject.ts. Names the
// vault has been TOLD about, because counting cannot tell a product name from a
// ticket prefix: both dominate several linked clusters identically.
export interface SubjectKnowledge {
  aliases?: string[][]
  umbrella?: string[]
}

export function mergeBySubject(
  communities: string[][],
  titleOf: (id: string) => string,
  adjacent: ReadonlyMap<string, ReadonlySet<string>>,
  known: SubjectKnowledge = {},
): TopicGroup[] {
  // Case-folded for counting; the first original spelling is what we display.
  const display = new Map<string, string>()
  const dominant: Set<string>[] = []
  const titlesWith: Map<string, number>[] = []
  // term → the communities it appears in at all, ascending
  const present = new Map<string, number[]>()

  communities.forEach((ids, c) => {
    const count = new Map<string, number>()
    for (const id of ids) {
      const tokens = titleTokens(titleOf(id))
      for (const token of tokens) {
        const key = token.toLowerCase()
        if (!display.has(key)) display.set(key, token)
      }
      for (const key of new Set(tokens.map((t) => t.toLowerCase()))) {
        count.set(key, (count.get(key) ?? 0) + 1)
      }
    }
    const dom = new Set<string>()
    for (const [key, n] of count) {
      const where = present.get(key)
      if (where) where.push(c)
      else present.set(key, [c])
      if (n >= MIN_SUBJECT_TITLES && n / ids.length >= DOMINANT_SHARE) dom.add(key)
    }
    dominant.push(dom)
    titlesWith.push(count)
  })

  // Which community pairs the link graph already joins.
  const communityOf = new Map<string, number>()
  communities.forEach((ids, c) => {
    for (const id of ids) communityOf.set(id, c)
  })
  const joined = new Set<string>()
  for (const [id, neighbours] of adjacent) {
    const a = communityOf.get(id)
    if (a === undefined) continue
    for (const neighbor of neighbours) {
      const b = communityOf.get(neighbor)
      if (b === undefined || b === a) continue
      joined.add(a < b ? `${a}:${b}` : `${b}:${a}`)
    }
  }

  const parent = communities.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root]! !== root) root = parent[root]!
    while (parent[i]! !== i) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }

  const umbrella = new Set((known.umbrella ?? []).map((t) => t.toLowerCase()))
  const named = new Set<string>()
  for (const group of known.aliases ?? []) for (const term of group) named.add(term.toLowerCase())

  const claims: { term: string; at: number; score: number }[] = []
  for (const term of [...present.keys()].sort()) {
    const where = present.get(term)!
    // Declared to span different things → never a merge reason (the SATURN
    // case). Declared to name one thing → may span any number of communities.
    // Undeclared → the cautious default of exactly two, because counting alone
    // cannot tell those two apart.
    if (umbrella.has(term)) continue
    const declared = named.has(term)
    if (!declared && where.length !== MAX_SUBJECT_COMMUNITIES) continue
    if (where.length < 2) continue
    if (!where.every((c) => dominant[c]!.has(term))) continue
    let merged = false
    for (let i = 1; i < where.length; i += 1) {
      const a = where[i - 1]!
      const b = where[i]!
      if (!joined.has(a < b ? `${a}:${b}` : `${b}:${a}`)) continue
      parent[find(a)] = find(b)
      merged = true
    }
    if (!merged) continue
    claims.push({
      term,
      at: where[0]!,
      score: where.reduce((sum, c) => sum + (titlesWith[c]!.get(term) ?? 0), 0),
    })
  }

  // The merged topic's subject: whichever winning term covers the most titles.
  // Claims are in sorted-term order, so an exact tie keeps the earlier term.
  const subjectOf = new Map<number, { term: string; score: number }>()
  for (const claim of claims) {
    const root = find(claim.at)
    const held = subjectOf.get(root)
    if (!held || claim.score > held.score) subjectOf.set(root, claim)
  }

  const grouped = new Map<number, string[]>()
  communities.forEach((ids, c) => {
    const root = find(c)
    const bucket = grouped.get(root)
    if (bucket) bucket.push(...ids)
    else grouped.set(root, [...ids])
  })
  return [...grouped]
    .map(([root, ids]): TopicGroup => {
      const held = subjectOf.get(root)
      return { ids: ids.sort(), subject: held ? (display.get(held.term) ?? held.term) : null }
    })
    .sort((a, b) => b.ids.length - a.ids.length || (a.ids[0]! < b.ids[0]! ? -1 : 1))
}
