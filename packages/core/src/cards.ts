import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { editedSinceResolution, snapshotTargetDigests, spentByResolution } from './card-digests.js'
import { createNote, loadNotes, mergeInto, readNote, retireNote, supersedeNote, verifyNote, writeNote } from './notes.js'
import { recordVerdict, type VerdictActor } from './verdicts.js'
import type { VaultPaths } from './vault.js'

export { editedSinceResolution } from './card-digests.js'

export const CARD_TYPES = ['new-note', 'supersede', 'conflict', 'stale', 'merge', 'chronology', 'closure'] as const
export type CardType = (typeof CARD_TYPES)[number]
export type CardStatus = 'proposed' | 'approved' | 'rejected' | 'dismissed'

export interface Card {
  id: string
  cardType: CardType
  targets: string[]
  rationale: string
  proposed: string
  status: CardStatus
  created: string
  resolved?: string
  target_digests?: Record<string, string>
  job?: string
  held?: string
}

interface CardInput {
  cardType: CardType
  targets: string[]
  rationale: string
  proposed?: string
  job?: string
}

function cardsDir(paths: VaultPaths): string {
  return join(paths.views, 'cards')
}

function cardFile(paths: VaultPaths, id: string): string {
  return join(cardsDir(paths), `${id}.md`)
}

function cardIdFor(input: CardInput): string {
  const digest = createHash('sha1')
    .update([input.cardType, ...input.targets, input.proposed ?? ''].join('\n'))
    .digest('hex')
  return `c-${digest.slice(0, 10)}`
}

function targetSetKey(targets: string[]): string {
  return [...targets].sort().join('\n')
}

export async function createCard(paths: VaultPaths, input: CardInput, now: Date = new Date()): Promise<Card> {
  let id = cardIdFor(input)
  const prior = await readCardOrNull(paths, id)
  if (prior) {
    if (prior.status === 'proposed' || !(await editedSinceResolution(paths, prior))) return prior
    id = `${id}-r${(prior.resolved ?? prior.created).replace(/\D/g, '').slice(0, 12)}`
    const reopened = await readCardOrNull(paths, id)
    if (reopened) return reopened
  }
  if (input.targets.length > 0) {
    const key = targetSetKey(input.targets)
    const twin = (await listCards(paths, 'proposed')).find(
      (c) => c.cardType === input.cardType && targetSetKey(c.targets) === key,
    )
    if (twin) return twin
  }
  const card: Card = {
    id,
    cardType: input.cardType,
    targets: input.targets,
    rationale: input.rationale,
    proposed: input.proposed ?? '',
    status: 'proposed',
    created: now.toISOString(),
    job: input.job,
  }
  await mkdir(cardsDir(paths), { recursive: true })
  await snapshotTargetDigests(paths, card)
  await writeCard(paths, card)
  return card
}

async function writeCard(paths: VaultPaths, card: Card): Promise<void> {
  const { id, cardType, targets, rationale, proposed, status, created, resolved, target_digests, job } = card
  const front: Record<string, unknown> = { id, cardType, targets, rationale, proposed, status, created }
  if (resolved) front['resolved'] = resolved
  if (target_digests && Object.keys(target_digests).length > 0) front['target_digests'] = target_digests
  if (job) front['job'] = job
  const body = `# [${cardType}] ${targets.join(', ')}\n\nRationale: ${rationale}\n`
  await writeFile(cardFile(paths, id), matter.stringify(body, front))
}

export async function holdCard(paths: VaultPaths, id: string, reason: string): Promise<void> {
  const card = await readCard(paths, id)
  card.held = reason.slice(0, 160)
  await writeCard(paths, card)
}

export async function readCard(paths: VaultPaths, id: string): Promise<Card> {
  const { data } = matter(await readFile(cardFile(paths, id), 'utf8'))
  return data as Card
}

async function readCardOrNull(paths: VaultPaths, id: string): Promise<Card | null> {
  try {
    return await readCard(paths, id)
  } catch {
    return null
  }
}

export async function listCards(paths: VaultPaths, status?: CardStatus): Promise<Card[]> {
  let files: string[] = []
  try {
    files = await readdir(cardsDir(paths))
  } catch {
    return []
  }
  const cards: Card[] = []
  for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
    const { data } = matter(await readFile(join(cardsDir(paths), file), 'utf8'))
    const card = data as Card
    if (!status || card.status === status) cards.push(card)
  }
  return cards
}

export async function findResolvedTwin(
  paths: VaultPaths,
  cardType: CardType,
  targets: string[],
): Promise<Card | undefined> {
  if (targets.length === 0) return undefined
  const key = targetSetKey(targets)
  const twins = (await listCards(paths)).filter(
    (c) => c.status !== 'proposed' && c.cardType === cardType && targetSetKey(c.targets) === key,
  )
  twins.sort((a, b) => (b.resolved ?? b.created).localeCompare(a.resolved ?? a.created))
  return twins[0]
}

export async function hasOpenCardFor(paths: VaultPaths, targets: string[]): Promise<Card | undefined> {
  if (targets.length === 0) return undefined
  const key = targetSetKey(targets)
  return (await listCards(paths)).find((c) => c.status === 'proposed' && targetSetKey(c.targets) === key)
}

interface ApproveOptions {
  choice?: 'A' | 'B' | 'both'
  action?: 'keep' | 'retire'
  actor?: VerdictActor
}

export async function approveCard(
  paths: VaultPaths,
  id: string,
  options: ApproveOptions = {},
  now: Date = new Date(),
): Promise<Card> {
  const card = await readCard(paths, id)
  if (card.status !== 'proposed') throw new Error(`card ${id} already ${card.status}`)
  switch (card.cardType) {
    case 'new-note':
      await createNote(paths, { body: card.proposed }, now)
      break
    case 'supersede': {
      const existing = await findCurrentNoteForProposal(paths, card.proposed, card.targets)
      if (existing) {
        existing.front.supersedes = [...new Set([...existing.front.supersedes, ...card.targets])]
        existing.front.updated = now.toISOString()
        await writeNote(paths, existing)
        for (const target of card.targets) await retireNote(paths, target, now)
      } else {
        await supersedeNote(paths, card.targets, { body: card.proposed }, now)
      }
      break
    }
    case 'conflict': {
      const [a, b] = card.targets
      if (!a || !b) throw new Error('conflict card needs two targets')
      const choice = options.choice ?? 'both'
      if (choice === 'both') {
        await verifyNote(paths, a, now)
        await verifyNote(paths, b, now)
      } else {
        await verifyNote(paths, choice === 'A' ? a : b, now)
        await retireNote(paths, choice === 'A' ? b : a, now)
      }
      break
    }
    case 'stale': {
      const action = options.action ?? 'retire'
      for (const target of card.targets) {
        if (action === 'keep') await verifyNote(paths, target, now)
        else await retireNote(paths, target, now)
      }
      break
    }
    case 'merge':
      await mergeInto(paths, card.targets, card.proposed, now)
      break
    case 'chronology': {
      const changes = JSON.parse(card.proposed) as { id: string; happened_at: string }[]
      for (const change of changes) {
        const note = await readNote(paths, change.id)
        note.front.happened_at = change.happened_at
        note.front.timeline = 'pinned'
        note.front.updated = now.toISOString()
        await writeNote(paths, note)
      }
      break
    }
    case 'closure': {
      for (const target of card.targets) {
        const note = await readNote(paths, target).catch(() => null)
        if (!note || note.front.open_loop !== true) continue
        note.front.open_loop = false
        note.front.updated = now.toISOString()
        await writeNote(paths, note)
      }
      break
    }
  }
  card.status = 'approved'
  card.resolved = now.toISOString()
  void recordVerdict(
    paths,
    {
      cardId: card.id,
      cardType: card.cardType,
      job: card.job,
      verdict: 'approved',
      actor: options.actor ?? 'user',
      choice: options.choice ?? options.action,
    },
    now,
  )
  await snapshotTargetDigests(paths, card)
  await writeCard(paths, card)
  await dismissOverlapping(paths, card, now)
  return card
}

export async function answerCardWithText(
  paths: VaultPaths,
  id: string,
  text: string,
  now: Date = new Date(),
): Promise<Card> {
  const card = await readCard(paths, id)
  if (card.status !== 'proposed') throw new Error(`card ${id} already ${card.status}`)
  const body = text.trim()
  if (!body) throw new Error('empty answer')
  const title = (body.split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, 60)
  const headed = body.startsWith('#') ? body : `# ${title}\n\n${body}`
  await supersedeNote(paths, card.targets, { body: headed }, now)
  card.status = 'approved'
  card.resolved = now.toISOString()
  await snapshotTargetDigests(paths, card)
  await writeCard(paths, card)
  await dismissOverlapping(paths, card, now)
  void recordVerdict(paths, { cardId: card.id, cardType: card.cardType, job: card.job, verdict: 'answered-in-text', actor: 'user' }, now)
  return card
}

async function dismissOverlapping(paths: VaultPaths, resolved: Card, now: Date): Promise<void> {
  if (resolved.targets.length === 0) return
  const touched = new Set(resolved.targets)
  const dismissedConflicts: Card[] = []
  for (const card of await listCards(paths, 'proposed')) {
    if (card.id === resolved.id) continue
    const shared = card.targets.filter((t) => touched.has(t))
    if (shared.length === 0) continue
    if (!(await spentByResolution(paths, card, shared))) continue
    card.status = 'dismissed'
    card.resolved = now.toISOString()
    await snapshotTargetDigests(paths, card)
    await writeCard(paths, card)
    if (card.cardType === 'conflict') dismissedConflicts.push(card)
  }
  for (const card of dismissedConflicts) await releaseDispute(paths, card, now)
}

async function releaseDispute(paths: VaultPaths, deadCard: Card, now: Date): Promise<void> {
  const stillClaimed = new Set(
    (await listCards(paths, 'proposed'))
      .filter((c) => c.cardType === 'conflict')
      .flatMap((c) => c.targets),
  )
  for (const id of deadCard.targets) {
    if (stillClaimed.has(id)) continue
    try {
      const note = await readNote(paths, id)
      if (note.front.status !== 'disputed') continue
      note.front.status = 'current'
      note.front.updated = now.toISOString()
      await writeNote(paths, note)
    } catch {
    }
  }
}

const PROPOSAL_SIMILARITY_THRESHOLD = 0.4

async function findCurrentNoteForProposal(paths: VaultPaths, proposed: string, exclude: string[]) {
  const wanted = normalizeBody(proposed)
  if (!wanted) return undefined
  const excluded = new Set(exclude)
  const pool = (await loadNotes(paths)).filter(
    (n) => (n.front.status === 'current' || n.front.status === 'disputed') && !excluded.has(n.front.id),
  )
  const exact = pool.find((n) => normalizeBody(n.body) === wanted)
  if (exact) return exact
  const title = firstHeading(proposed)
  if (!title) return undefined
  return pool.find(
    (n) => firstHeading(n.body) === title && bigramSimilarity(wanted, normalizeBody(n.body)) >= PROPOSAL_SIMILARITY_THRESHOLD,
  )
}

function firstHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  return match ? match[1]!.trim() : ''
}

function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const grams = (s: string) => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const g of ga) if (gb.has(g)) shared++
  return shared / (ga.size + gb.size - shared)
}

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim()
}

export async function updateCardProposed(paths: VaultPaths, id: string, proposed: string): Promise<Card> {
  const card = await readCard(paths, id)
  if (card.status !== 'proposed') throw new Error(`card ${id} already ${card.status}`)
  void recordVerdict(paths, { cardId: card.id, cardType: card.cardType, job: card.job, verdict: 'edited', actor: 'user' })
  card.proposed = proposed
  await writeCard(paths, card)
  return card
}

export async function rejectCard(
  paths: VaultPaths,
  id: string,
  reason: string,
  now: Date = new Date(),
  actor: VerdictActor = 'user',
): Promise<Card> {
  const card = await readCard(paths, id)
  if (card.status !== 'proposed') throw new Error(`card ${id} already ${card.status}`)
  card.status = 'rejected'
  card.resolved = now.toISOString()
  await snapshotTargetDigests(paths, card)
  await writeCard(paths, card)
  if (card.cardType === 'conflict') await releaseDispute(paths, card, now)
  await appendCounterexample(paths, `[${card.cardType}] ${reason}`, now)
  void recordVerdict(paths, { cardId: card.id, cardType: card.cardType, job: card.job, verdict: 'rejected', actor, reason }, now)
  return card
}

const COUNTEREXAMPLE_LIMIT = 20

export async function appendCounterexample(paths: VaultPaths, entry: string, now: Date): Promise<void> {
  const agentsPath = join(paths.workspace, 'AGENTS.md')
  const content = await readFile(agentsPath, 'utf8')
  const marker = '## Counterexamples'
  const at = content.indexOf(marker)
  if (at === -1) throw new Error('AGENTS.md has no ## Counterexamples section')
  const head = content.slice(0, at + marker.length)
  const tail = content.slice(at + marker.length)
  const commentMatch = tail.match(/^\s*<!--[\s\S]*?-->/)
  const comment = commentMatch ? commentMatch[0] : ''
  const rest = tail.slice(comment.length)
  const items = rest
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .slice(-(COUNTEREXAMPLE_LIMIT - 1))
  items.push(`- ${entry} (${now.toISOString().slice(0, 10)})`)
  await writeFile(agentsPath, `${head}${comment}\n\n${items.join('\n')}\n`)
}
