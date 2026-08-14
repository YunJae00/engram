import { createHash } from 'node:crypto'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addAliasGroup, coveredByAliases } from '../aliases.js'
import {
  createCard,
  editedSinceResolution,
  findResolvedTwin,
  hasOpenCardFor,
  listCards,
  type Card,
  type CardType,
} from '../cards.js'
import { readContext, readOrigin, stripProvenanceMarkers } from '../capture.js'
import { extractJson } from '../engine/types.js'
import { undeterminedNotes } from '../chronology.js'
import { freshnessOf } from '../freshness.js'
import { daysUntilDue, groupOpenLoops } from '../loops.js'
import { createNote, filterByStatus, disputeNotes, readNote, writeNote } from '../notes.js'
import type { DecayLevel, Note } from '../schema.js'
import { DECAY_LEVELS, noteTitle } from '../schema.js'
import { buildIndex, searchIndex } from '../search.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt, type JobKind } from './prompts.js'
import type { JobSpec } from './runner.js'

// J1~J8 job builders. Each returns a JobSpec whose apply()
// parses the engine output and lands the effects through core operations.

const digest = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)

function noteSummary(n: Note) {
  return { id: n.front.id, title: noteTitle(n), status: n.front.status, excerpt: n.body.slice(0, 300) }
}

// Token diet: retrieved CANDIDATE notes are the bulk of J2/J3/J4 prompts, so
// their excerpts are trimmed to 200 chars. Delta/target notes keep the full
// 300 via noteSummary — they are few and carry the change under review.
function candidateSummary(n: Note) {
  return { id: n.front.id, title: noteTitle(n), status: n.front.status, excerpt: n.body.slice(0, 200) }
}

// Retrieval-bounded candidate selection (the vault-size cost cliff). Prompts
// used to embed the ENTIRE current corpus, so J2/J3/J4 grew linearly with the
// vault. Instead we index the corpus once and keep only the notes a fulltext
// query for each target actually retrieves — deterministic, capped, and never
// including the targets themselves.
const HITS_PER_TARGET = 15

// One fulltext index per corpus SNAPSHOT (weakly keyed on the array): J2 runs
// per fresh note, and a bulk capture used to rebuild the full index for every
// single one — 23 dropped files meant 23 index builds. processCapture and
// sweep both thread one corpus array through a run, so each run indexes once;
// target exclusion moved from the pool to a result filter (same candidates).
const corpusIndexCache = new WeakMap<Note[], ReturnType<typeof buildIndex>>()

function indexFor(corpus: Note[]): ReturnType<typeof buildIndex> {
  let index = corpusIndexCache.get(corpus)
  if (!index) {
    index = buildIndex(corpus)
    corpusIndexCache.set(corpus, index)
  }
  return index
}

// Exported so sweep() can compute the (delta, corpus) retrieval once and share
// it between J3 and J4 — both use the same inputs and the same cap, and the
// index build + per-target search is the priciest CPU step of queueing a sweep.
export function boundedCandidates(targets: Note[], corpus: Note[], cap: number): Note[] {
  const targetIds = new Set(targets.map((n) => n.front.id))
  // A note is never a candidate for itself.
  const pool = corpus.filter((n) => !targetIds.has(n.front.id))
  // Small vaults are unchanged: at or below the cap we send the whole pool and
  // skip retrieval entirely.
  if (pool.length <= cap) return pool
  const index = indexFor(corpus)
  const bestScore = new Map<string, number>()
  for (const target of targets) {
    const query = `${noteTitle(target)} ${target.body.slice(0, 200)}`
    let kept = 0
    for (const hit of searchIndex(index, query)) {
      if (targetIds.has(hit.id)) continue
      const prev = bestScore.get(hit.id)
      if (prev === undefined || hit.score > prev) bestScore.set(hit.id, hit.score)
      if (++kept >= HITS_PER_TARGET) break
    }
  }
  const byId = new Map(pool.map((n) => [n.front.id, n]))
  return [...bestScore.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, cap)
    .map(([id]) => byId.get(id))
    .filter((n): n is Note => n !== undefined)
}

interface CardJson {
  cardType: CardType
  targets: string[]
  rationale: string
  proposed?: string
}

function asCards(parsed: unknown): CardJson[] {
  const obj = parsed as { cards?: CardJson[] }
  return Array.isArray(obj?.cards) ? obj.cards : []
}

function isSubstantialProposal(text: string | undefined): boolean {
  const t = (text ?? '').trim()
  if (t.length < 12) return false
  if (/^\[[\s\S]*\]$/.test(t)) return false // pure bracket pointer
  // a single short line naming a note id is a reference, not a body
  if (!t.includes('\n') && t.length < 80 && /n-[a-z0-9][a-z0-9-]*/i.test(t)) return false
  return true
}

// Judgment types where the model re-derives the same finding from the same
// notes every sweep. stale/chronology are exempt: time itself changes them.
const REASKABLE = new Set(['conflict', 'merge', 'supersede'])

async function applyCards(paths: VaultPaths, kind: JobKind, cards: CardJson[], now: Date): Promise<string[]> {
  const effects: string[] = []
  for (const card of cards) {
    if ((card.cardType === 'supersede' || card.cardType === 'merge') && !isSubstantialProposal(card.proposed)) {
      effects.push(`ignored: replacement body too thin (${(card.proposed ?? '').trim().slice(0, 40) || 'empty'})`)
      continue
    }
    // Engines hallucinate ids — only ever act on notes that really exist.
    const existing: string[] = []
    const targetNotes: Note[] = []
    for (const target of card.targets ?? []) {
      try {
        targetNotes.push(await readNote(paths, target))
        existing.push(target)
      } catch {
        effects.push(`ignored: target does not exist (${target})`)
      }
    }
    if (existing.length === 0 || (card.cardType === 'conflict' && existing.length < 2)) continue
    const gone = targetNotes.filter((n) => n.front.status === 'superseded')
    if (gone.length > 0) {
      effects.push(`ignored: targets already superseded ${gone.map((n) => n.front.id).join(', ')} (${card.cardType})`)
      continue
    }
    // Answered memory: same finding on unchanged notes = the user already
    // decided this once; only a real BODY edit after that decision re-opens
    // it (editedSinceResolution — the librarian's own frontmatter surgery on
    // neighbours must not resurrect settled questions).
    if (REASKABLE.has(card.cardType)) {
      const prior = await findResolvedTwin(paths, card.cardType as CardType, existing)
      if (prior && !(await editedSinceResolution(paths, prior))) {
        effects.push(`ignored: already answered (${prior.id}, ${prior.status})`)
        continue
      }
    }
    // One pair of notes, one question. A conflict says only "these disagree",
    // while a supersede or merge arrives with a body the user can approve, so
    // when a pair already has an open card the conflict is the redundant one —
    // and two entries for one decision means answering either leaves the other
    // looking unanswered.
    if (card.cardType === 'conflict') {
      const open = await hasOpenCardFor(paths, existing)
      if (open) {
        effects.push(`ignored: an open card already covers these targets (${open.id} [${open.cardType}])`)
        continue
      }
    }
    const created = await createCard(paths, { ...card, targets: existing, job: kind }, now)
    effects.push(`card raised: ${created.id} [${created.cardType}] → ${existing.join(', ')}`)
    if (card.cardType === 'conflict') {
      await disputeNotes(paths, existing, now)
      effects.push(`marked disputed: ${existing.join(', ')}`)
    }
  }
  return effects
}

export type Autonomy = 'conservative' | 'balanced' | 'autonomous'

function parseValidUntil(value: string | undefined): string | undefined {
  if (!value) return undefined
  const stamped = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59` : value
  return Number.isNaN(Date.parse(stamped)) ? undefined : stamped
}

function parseDueAt(value: string | undefined): string | undefined {
  if (!value) return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

export function buildJ1(
  paths: VaultPaths,
  agentsMd: string,
  file: string,
  content: string,
  now: Date,
  autonomy: Autonomy = 'balanced',
): JobSpec {
  return {
    kind: 'J1',
    disallowTools: true,
    inputKey: `${file}:${digest(content)}`,
    ...withPrompt(
      agentsMd,
      'J1',
      'Turn the capture below into ONE note. Output only JSON {"type","decay","body","happened_at"?,"valid_until"?,"salience"?,"triggers"?,"open_loop"?,"due_at"?}. `body` is markdown including a `# title` line, written in the same language as the capture. Pick `decay` from the assignment table.\n' +
        'If the content states a concrete moment — a deadline, an appointment, an event — record it as "valid_until" (ISO date): the information holds only until then. No such moment, no valid_until.\n' +
        'If the content carries a strong marker of importance (never, must, do not forget, critical), add "salience":"high" — only when certain.\n' +
        'If it is a conditional reminder ("next time I do X, …"), record that X as "triggers":["X"] (1–3 keywords, 2–24 chars each) so the memory resurfaces when the topic comes up again.\n' +
        'If the capture holds work of mine that is not finished, add "open_loop":true — things I said I would do, replies/submissions/calls still to send, deferred decisions, open questions, and **lists of not-yet-handled items** (a backlog, what is left, a checklist, an audit result — anything whose title or body says incomplete). Do not demote a list to reference material just because it is a list; several things to do is more of an open loop, not less. Do not set it on facts, definitions, pure reference, finished work, or work that has passed to someone else. When unsure, leave it off — a false positive comes back every morning as noise.\n' +
        'Add "due_at":"YYYY-MM-DD" only when the deadline is written in the content. Never invent a date.',
      // The provenance markers are bookkeeping between writeCapture and this
      // job — stripped here so no engine is ever tempted to copy one into a
      // memory's body. The frontmatter fields below read the RAW content.
      { file, content: stripProvenanceMarkers(content) },
    ),
    async apply(result) {
      const parsed = extractJson(result) as {
        type?: string
        decay?: string
        body?: string
        happened_at?: string
        valid_until?: string
        salience?: string
        triggers?: unknown
        open_loop?: unknown
        due_at?: string
      }
      if (!parsed.body) throw new Error('J1: engine result has no body')
      const validUntil = parseValidUntil(parsed.valid_until)
      // A deadline only means something on an open loop (AGENTS.md §1), so a
      // due_at the engine attached to a plain fact is dropped rather than
      // written as a field nothing will ever read.
      const openLoop = parsed.open_loop === true
      const dueAt = openLoop ? parseDueAt(parsed.due_at) : undefined
      const chosen = DECAY_LEVELS.includes(parsed.decay as DecayLevel) ? (parsed.decay as DecayLevel) : 'slow'
      // evergreen ignores verified_until in freshnessOf — a dated note must decay
      const decay = validUntil && chosen === 'evergreen' ? 'fast' : chosen
      const sourceRel = join('sources', file)
      // Claim the scrap BEFORE writing anything: rename is atomic, so when the
      // same inbox file was enqueued twice (capture pipeline + sweep drain
      // racing), the loser lands here after the winner moved it and must skip
      // instead of absorbing the capture a second time.
      try {
        await rename(join(paths.inbox, file), join(paths.sources, file))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [`skipped: inbox/${file} was already absorbed`]
        throw err
      }
      try {
        if (autonomy === 'conservative') {
          const card = await createCard(
            paths,
            { cardType: 'new-note', targets: [], rationale: `proposed note for capture ${file}`, proposed: parsed.body, job: 'J1' },
            now,
          )
          return [`new-note card: ${card.id} (conservative mode)`, `original moved: inbox/${file} → ${sourceRel}`]
        }
        const triggers = (Array.isArray(parsed.triggers) ? parsed.triggers : [])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter((t) => t.length >= 2 && t.length <= 24)
          .slice(0, 3)
        const note = await createNote(
          paths,
          {
            body: parsed.body,
            type: parsed.type ?? 'note',
            decay,
            happened_at: parsed.happened_at,
            verified_until: validUntil,
            source: sourceRel,
            salience: parsed.salience === 'high' ? 'high' : undefined,
            triggers: triggers.length > 0 ? triggers : undefined,
            open_loop: openLoop ? true : undefined,
            due_at: dueAt,
            // Carried from the capture file, not inferred: origin decides
            // whether the librarian may later tidy this note without asking,
            // and context says which folder the memory came from.
            origin: readOrigin(content) === 'session' ? 'session' : undefined,
            context: readContext(content),
          },
          now,
        )
        return [`note created: ${note.front.id} (${note.front.type}/${note.front.decay})`, `original moved: inbox/${file} → ${sourceRel}`]
      } catch (err) {
        // Give the claim back so the scrap stays retryable in inbox.
        await rename(join(paths.sources, file), join(paths.inbox, file)).catch(() => undefined)
        throw err
      }
    },
  }
}

// J2 candidate widening: fulltext retrieval alone misses paraphrases (the
// index is lexical), so the pool is the union of (a) fulltext top-30 for the
// target, (b) the 10 most recently updated notes — capture bursts are
// topically related — and (c) up to 10 recent same-type notes. Hub notes are
// excluded: they are synthesized FROM the link graph, never link targets.
// The non-hub pool and its recency order are per-CORPUS, not per-note — cache
// them on the corpus array so a run's 20+ J2 builds share one pool identity
// (which in turn lets boundedCandidates share one fulltext index).
const j2PoolCache = new WeakMap<Note[], { pool: Note[]; byRecency: Note[] }>()

function j2Candidates(target: Note, current: Note[]): Note[] {
  let cached = j2PoolCache.get(current)
  if (!cached) {
    const pool = current.filter((n) => n.front.type !== 'hub')
    cached = {
      pool,
      byRecency: [...pool].sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated)),
    }
    j2PoolCache.set(current, cached)
  }
  const self = target.front.id
  const picked = new Map<string, Note>()
  // boundedCandidates excludes the target structurally (targets param).
  for (const n of boundedCandidates([target], cached.pool, 30)) picked.set(n.front.id, n)
  for (const n of cached.byRecency.filter((c) => c.front.id !== self).slice(0, 10)) picked.set(n.front.id, n)
  for (const n of cached.byRecency.filter((c) => c.front.id !== self && c.front.type === target.front.type).slice(0, 10)) {
    picked.set(n.front.id, n)
  }
  return [...picked.values()].slice(0, 40)
}

export function buildJ2(paths: VaultPaths, agentsMd: string, target: Note, corpus: Note[], now: Date): JobSpec {
  const candidates = j2Candidates(target, corpus).map(candidateSummary)
  return {
    kind: 'J2',
    disallowTools: true,
    inputKey: `${target.front.id}:${digest(target.body)}`,
    ...withPrompt(
      agentsMd,
      'J2',
      'Pick the existing notes genuinely related to the new one. For each link, write one short line in `reason` saying WHY they are related (under 60 characters, in the language of the notes). Output only JSON {"links":[{"id":"...","reason":"..."}]}. Empty array when unsure.',
      { note: { id: target.front.id, body: target.body }, candidates },
    ),
    async apply(result) {
      // Accept both the new {id,reason} objects and the legacy bare-id strings
      // (older AGENTS.md counterexamples may steer a model to the old shape).
      const parsed = extractJson(result) as { links?: (string | { id?: string; reason?: string })[] }
      const entries = (parsed.links ?? [])
        .map((l) => (typeof l === 'string' ? { id: l, reason: '' } : { id: l.id ?? '', reason: (l.reason ?? '').trim() }))
        .filter((l) => candidates.some((c) => c.id === l.id))
      if (entries.length === 0) return ['no links']
      const note = await readNote(paths, target.front.id)
      note.front.derived_from = [...new Set([...note.front.derived_from, ...entries.map((e) => e.id)])]
      const reasons = { ...(note.front.link_reasons ?? {}) }
      for (const e of entries) if (e.reason) reasons[e.id] = e.reason.slice(0, 120)
      if (Object.keys(reasons).length > 0) note.front.link_reasons = reasons
      note.front.updated = now.toISOString()
      await writeNote(paths, note)
      return [`linked: ${target.front.id} ← ${entries.map((e) => e.id).join(', ')}`]
    },
  }
}

export function buildJ3(paths: VaultPaths, agentsMd: string, delta: Note[], corpus: Note[], now: Date, candidates?: Note[]): JobSpec {
  const deltaIds = delta.map((n) => n.front.id).sort()
  return {
    kind: 'J3',
    disallowTools: true,
    modelHint: 'default', // judgment job — contradiction calls stay on the smart model
    inputKey: digest(deltaIds.join(',')),
    ...withPrompt(
      agentsMd,
      'J3',
      'Find pairs where a new or changed note genuinely contradicts an existing current note.\n' +
        '**Work having progressed is NOT a contradiction.** Exclude all of these:\n' +
        '- old "not fixed yet" → new "fixed" (the bug got fixed)\n' +
        '- old "only A is left" / "closed" → new "B found too" (the list grew)\n' +
        '- old "none / not adopted" → new "adopted / running" (it happened in between)\n' +
        '- two progress snapshots of the same work (the later one is the current state)\n' +
        'The test: **"is the later note simply right?"** Then it is not a contradiction. Raise nothing.\n' +
        'It is a contradiction only when both claims cannot be true of the same moment — the same thing measured with different numbers, the same symptom blamed on different causes or environments, or two things each correct alone that break when applied together.\n' +
        'Output only JSON {"cards":[{"cardType":"conflict","targets":[A,B],"rationale","proposed"}]}. Empty array when there is nothing.',
      { changed: delta.map(noteSummary), corpus: (candidates ?? boundedCandidates(delta, corpus, 60)).map(candidateSummary) },
    ),
    apply: async (result) => applyCards(paths, 'J3', asCards(extractJson(result)), now),
  }
}

export function buildJ4(paths: VaultPaths, agentsMd: string, delta: Note[], corpus: Note[], now: Date, candidates?: Note[]): JobSpec {
  const deltaIds = delta.map((n) => n.front.id).sort()
  return {
    kind: 'J4',
    disallowTools: true,
    modelHint: 'default', // judgment job — supersede proposals must be real bodies
    inputKey: digest(deltaIds.join(',')),
    ...withPrompt(
      agentsMd,
      'J4',
      'Pick only the pairs that satisfy EVERY supersede test. `proposed` must contain the complete markdown body of the replacement note (including its `# title` and the full current content) — never a pointer or a summary like "replaced by …". Raise no card when unsure. Output only JSON {"cards":[{"cardType":"supersede","targets":[old note ids...],"rationale","proposed":"new note body"}]}.',
      { changed: delta.map(noteSummary), corpus: (candidates ?? boundedCandidates(delta, corpus, 60)).map(candidateSummary) },
    ),
    apply: async (result) => applyCards(paths, 'J4', asCards(extractJson(result)), now),
  }
}

export function buildJ5(paths: VaultPaths, agentsMd: string, staleNotes: Note[], now: Date): JobSpec {
  const ids = staleNotes.map((n) => n.front.id).sort()
  return {
    kind: 'J5',
    disallowTools: true,
    inputKey: digest(ids.join(',')),
    ...withPrompt(
      agentsMd,
      'J5',
      'These notes have expired or are close to expiring. Raise a stale card for each. Output only JSON {"cards":[{"cardType":"stale","targets":[id],"rationale","proposed"}]}.',
      { stale: staleNotes.map((n) => ({ ...noteSummary(n), verified_until: n.front.verified_until })) },
    ),
    apply: async (result) => applyCards(paths, 'J5', asCards(extractJson(result)), now),
  }
}

export function buildJ6(paths: VaultPaths, agentsMd: string, targets: Note[], now: Date): JobSpec {
  const ids = targets.map((n) => n.front.id).sort()
  return {
    kind: 'J6',
    disallowTools: true,
    inputKey: digest(ids.join(',')),
    ...withPrompt(
      agentsMd,
      'J6',
      'Infer happened_at from dates and context in the body. Output only JSON {"estimates":[{"id","happened_at":"YYYY-MM-DD"}]}. Leave out any note with no usable clue.',
      { notes: targets.map((n) => ({ id: n.front.id, created: n.front.created, body: n.body.slice(0, 500) })) },
    ),
    async apply(result) {
      const parsed = extractJson(result) as { estimates?: { id: string; happened_at: string }[] }
      const effects: string[] = []
      for (const estimate of parsed.estimates ?? []) {
        if (!targets.some((t) => t.front.id === estimate.id)) continue
        const note = await readNote(paths, estimate.id)
        if (note.front.timeline === 'pinned') continue // never touch pinned
        note.front.happened_at = estimate.happened_at
        note.front.timeline = 'inferred'
        note.front.updated = now.toISOString()
        await writeNote(paths, note)
        effects.push(`dated: ${estimate.id} → ${estimate.happened_at}`)
      }
      return effects.length ? effects : ['no estimates']
    },
  }
}

export function buildJ7(
  paths: VaultPaths,
  agentsMd: string,
  clusters: Note[][],
  now: Date,
  knownAliases: string[][] = [],
): JobSpec {
  const clusterIds = clusters.map((c) => c.map((n) => n.front.id).sort())
  return {
    kind: 'J7',
    disallowTools: true,
    modelHint: 'default', // judgment job — merged bodies must be real bodies
    inputKey: digest(clusterIds.map((ids) => ids.join(',')).join(';')),
    ...withPrompt(
      agentsMd,
      'J7',
      'Each cluster is a set of notes already judged near-identical. Propose a merge only for the notes inside a cluster that genuinely can be merged. `proposed` must contain the complete merged markdown body (including its `# title`), written in the language of the notes — never a pointer phrase. Separately, if you notice the notes calling the same thing by different names (aliases of a product, project or person; a name written in two scripts; an abbreviation), report them as "aliases":[["name A","name B"],...] — only the certain ones, excluding pairs already in known_aliases. Output only JSON {"cards":[{"cardType":"merge","targets":[id...],"rationale","proposed":"merged body"}],"aliases":[["name A","name B"]]}. Empty arrays when there is nothing.',
      { clusters: clusters.map((c) => c.map(candidateSummary)), known_aliases: knownAliases },
    ),
    async apply(result) {
      const parsed = extractJson(result)
      const effects = await applyCards(paths, 'J7', asCards(parsed), now)
      const rawAliases = (parsed as { aliases?: unknown }).aliases
      const pairs = Array.isArray(rawAliases) ? rawAliases.slice(0, 8) : []
      for (const pair of pairs) {
        if (!Array.isArray(pair)) continue
        const terms = pair.filter((t): t is string => typeof t === 'string')
        if (coveredByAliases(terms, knownAliases)) continue
        const group = await addAliasGroup(paths, terms)
        if (group) effects.push(`aliases recorded: ${group.join(' = ')} (aliases.md)`)
      }
      return effects
    },
  }
}

export function looksLikeBriefRefusal(text: string): boolean {
  const lower = text.toLowerCase()
  const ko = /(도구|툴)[^\n]{0,8}비활성화|비활성화[^\n]{0,8}(도구|툴)|파일[^\n]{0,8}(쓰기|저장|생성|작성)[^\n]{0,12}(비활성화|없|불가|못|안\s?됩)/
  const en = /(tool|tools|file[- ]?writing)[^\n]{0,24}(disabled|not enabled|unavailable|turned off)|(disabled|not enabled)[^\n]{0,24}(tool|file)|(can(?:not|['’]?t)|unable to|couldn['’]?t)\s+(write|save|create|generate)[^\n]{0,24}file/
  return ko.test(text) || en.test(lower)
}

// Content-only: the engine returns just the brief markdown. Some engines still
// wrap the whole answer in a ```markdown fence — unwrap it so it renders as a
// brief, not a code block. (Shared with J10's weekly digest.)
export function stripBriefBody(result: string): string {
  const body = result.trim()
  const fenced = body.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return (fenced ? fenced[1]! : body).trim()
}

export interface BriefCard {
  id: string
  cardType: CardType
  title: string
  related?: number
}

// The J8 brief names at most this many freshly-created cards — a bounded,
// human-scannable list even when a big sweep raises dozens of proposals.
const BRIEF_CARDS_CAP = 10

// Primary target note title for a card. new-note cards carry no target, so
// their title comes from the proposed body's first line; a missing/deleted
// target falls back to the card id (never throws).
async function cardBriefTitle(paths: VaultPaths, card: Card): Promise<string> {
  const primary = card.targets[0]
  if (primary) {
    try {
      return noteTitle(await readNote(paths, primary))
    } catch {
      /* target note gone — fall through to the proposed body / id */
    }
  }
  for (const line of (card.proposed ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.replace(/^#+\s*/, '')
  }
  return card.id
}

// Cards CREATED during a sweep, for the J8 brief input. Diffs the
// current card list against the ids present before the sweep ran, folds cards
// that touch the same notes into one issue line (lead = most consequential
// type), keeps a deterministic capped slice, and resolves the lead card's
// primary target title. Core owns this diff — main's activity stream computes
// its own independently.
const BRIEF_TYPE_RANK: CardType[] = ['conflict', 'supersede', 'merge', 'stale', 'chronology', 'new-note']

export async function newCardsForBrief(paths: VaultPaths, before: Set<string>): Promise<BriefCard[]> {
  return briefCardsFrom(paths, (await listCards(paths)).filter((card) => !before.has(card.id)))
}

// Every question still waiting on the user, for a brief written outside a
// sweep. The sweep asks "what appeared just now"; a brief the user asked for
// has to answer "what is waiting", which includes yesterday's unanswered card.
export async function pendingCardsForBrief(paths: VaultPaths): Promise<BriefCard[]> {
  return briefCardsFrom(paths, await listCards(paths, 'proposed'))
}

async function briefCardsFrom(paths: VaultPaths, source: Card[]): Promise<BriefCard[]> {
  const cards: BriefCard[] = []
  for (const group of groupByTargetOverlap(source).slice(0, BRIEF_CARDS_CAP)) {
    const lead = [...group].sort(
      (a, b) => BRIEF_TYPE_RANK.indexOf(a.cardType) - BRIEF_TYPE_RANK.indexOf(b.cardType) || a.id.localeCompare(b.id),
    )[0]!
    const entry: BriefCard = { id: lead.id, cardType: lead.cardType, title: await cardBriefTitle(paths, lead) }
    if (group.length > 1) entry.related = group.length - 1
    cards.push(entry)
  }
  return cards
}

// Connected components over shared targets. Targetless cards (new-note) each
// stand alone. Deterministic: components keep first-seen card order.
function groupByTargetOverlap(cards: Card[]): Card[][] {
  const groups: { targets: Set<string>; cards: Card[] }[] = []
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
    // merge every group this card bridges into the first one
    const [head, ...rest] = hits
    head!.cards.push(card)
    for (const t of card.targets) head!.targets.add(t)
    for (const dead of rest) {
      head!.cards.push(...dead.cards)
      for (const t of dead.targets) head!.targets.add(t)
      groups.splice(groups.indexOf(dead), 1)
    }
  }
  return groups.map((g) => g.cards)
}

export interface BriefLoop {
  id: string
  title: string
  due_at?: string
  days?: number
  excerpt: string
}

const BRIEF_LOOPS_CAP = 12
// Enough of a note to find the next step in (a ticket id, a PR number, the
// first unchecked line) without pasting whole backlogs into the prompt.
const BRIEF_LOOP_EXCERPT = 420

function briefLoop(note: Note, now: Date): BriefLoop {
  const entry: BriefLoop = {
    id: note.front.id,
    title: noteTitle(note),
    // Drop the title line and blank lines; keep the substance, in order, so
    // the top of a prioritised backlog is what survives the cap.
    excerpt: note.body
      .replace(/^#.*$/m, '')
      .split('\n')
      .filter((line) => line.trim())
      .join('\n')
      .slice(0, BRIEF_LOOP_EXCERPT),
  }
  const days = daysUntilDue(note, now)
  if (note.front.due_at && days !== null) {
    entry.due_at = note.front.due_at.slice(0, 10)
    entry.days = days
  }
  return entry
}

// Open loops for the J8 brief, split the way the brief reads. `loops` is what
// this morning actually asks of the user — overdue, due today, and the undated
// intentions that would otherwise rot unseen; concatenating those buckets in
// urgency order preserves the openLoops() sort exactly. `upcoming` is the
// rolling week ahead. The 'later' bucket is deliberately in neither: a deadline
// eleven days out is not a morning concern, and it arrives in `upcoming` on its
// own once the rolling window reaches it.
export function openLoopsForBrief(notes: Note[], now: Date): { loops: BriefLoop[]; upcoming: BriefLoop[] } {
  const grouped = groupOpenLoops(notes, now)
  const urgent = [...grouped.overdue, ...grouped.today, ...grouped['no-deadline']]
  return {
    loops: urgent.slice(0, BRIEF_LOOPS_CAP).map((n) => briefLoop(n, now)),
    upcoming: grouped['this-week'].slice(0, BRIEF_LOOPS_CAP).map((n) => briefLoop(n, now)),
  }
}

// The J8 instruction: a short, human brief in the vault notes' language, in the
// exact three-section shape. Kept as a named constant so the format contract is
// testable and stays byte-identical across builds.
export const J8_INSTRUCTION = [
  "This is the first thing the user reads in the morning. Write what THEY have to do, not what the librarian did. Output markdown only, 220 words or fewer.",
  "Keep the three section headings in English exactly as written below — the app chrome is English and these headings are part of the screen. Do not translate them. Write the CONTENT in the language of the vault notes.",
  "Use only these three sections, in this order. When the matching input array is empty, drop that section entirely, heading included — never leave a bare heading.",
  "",
  "## Today’s briefing",
  "- **<name of the piece of work>** — <the next single step, taken from the excerpt>",
  "",
  "## Coming up",
  "- **<title from upcoming>** — <one line saying by when>",
  "",
  "## To review",
  "- **<title from cards>** — <one line of why>",
  "",
  "Each item in 'loops' arrives with part of its note body as `excerpt`. Draw the line's content FROM that excerpt — a ticket number, a PR number, the name of an item still undone, the concrete next action. Bad: 'needs the remaining work handled'. Good: 'SATURN-162 starting at the thinking gate — branch off dev and port'.",
  "When one piece of work is scattered across several notes, fold it into ONE line. Tickets sharing a number (SATURN-162 and CHATX-162 are the same 162), the same topic in the same project, one note pointing at another — all one piece of work. Do not mechanically emit a line per note. The user needs a list of things to do, not a list of notes.",
  "Fold, but put exactly one startable action on a line. Never chain two — the reader would have to choose again. When a folded item has several next steps, write only the first one and stop. When something must be finished first, that prerequisite IS the action for that line.",
  "Every line under the briefing heading is an instruction, not a report. Do not end them as descriptions of work already done; end them with the action to take.",
  "The bold label is the name of the work, kept short — not a copy of the note title. Never put two dashes in a label.",
  "Restating the title is not an answer. Lines writable from the title alone (\"still incomplete\", \"needs review\") are forbidden; they tell the user nothing.",
  "When the excerpt does not contain a next step, do not invent one. Say what is missing instead: \"no next item recorded — open it and decide\". Ticket numbers, PR numbers and dates may only be repeated from the excerpt, never created.",
  "A negative `days` means overdue by that many days, 0 means due today, no `days` means open with no deadline. 'upcoming' is what falls due within the week, so name the date.",
  "When 'loops' has more than three items, put ONE plain sentence above the list (not a bullet, must not start with '- ') saying where to start. That work must be the same as the first line right below it. Even when nothing has a deadline there is still an order: what blocks other work, what is already half done, what someone else is waiting on.",
  "'cards' gets exactly one line per card, and the bold label repeats the input title verbatim. When `related` is present, that many related questions are bundled into the same issue — do not give them their own lines; fold that into the one line's reason.",
  "When all three arrays are empty, write no sections at all — just one line saying nothing is urgent today.",
  "Forbidden: tables, disclaimers, any mention of the input/tools/file saving, apologies, headings other than the three above, code fences.",
].join('\n')

export function buildJ8(paths: VaultPaths, agentsMd: string, summary: unknown, now: Date): JobSpec {
  const date = now.toISOString().slice(0, 10)
  return {
    kind: 'J8',
    disallowTools: true,
    modelHint: 'default', // the daily brief is user-facing prose — smart model
    inputKey: `${date}:${digest(JSON.stringify(summary))}`,
    ...withPrompt(agentsMd, 'J8', J8_INSTRUCTION, summary),
    async apply(result) {
      const body = stripBriefBody(result)
      // Never persist an apology/refusal as the brief — fail so the runner logs
      // it and the board's Today sheet keeps the last good brief (or its empty state).
      if (!body || looksLikeBriefRefusal(body)) throw new Error('J8: engine returned a refusal instead of brief markdown')
      const file = join(paths.views, `brief-${date}.md`)
      await writeFile(file, body + '\n')
      return [`brief written: _views/brief-${date}.md`]
    },
  }
}

// Helpers shared by sweep/capture pipelines.
export async function listInbox(paths: VaultPaths): Promise<string[]> {
  try {
    return (await readdir(paths.inbox)).filter((f) => !f.startsWith('.')).sort()
  } catch {
    return []
  }
}

export async function readInboxFile(paths: VaultPaths, file: string): Promise<string> {
  return readFile(join(paths.inbox, file), 'utf8')
}

export function imminentOrStale(notes: Note[], now: Date): Note[] {
  return filterByStatus(notes, 'current').filter((n) => {
    const f = freshnessOf(n, now)
    return f === 'aging' || f === 'stale'
  })
}

// Per-sweep J5 cap: keep only the `cap` notes whose verification is furthest
// gone. Missing verified_until = never verified = oldest; ties break by id.
// Whatever is dropped stays stale and re-qualifies on the next sweep, so J5's
// cost stays constant without ever losing a note.
export function oldestStale(stale: Note[], cap: number): Note[] {
  return [...stale]
    .sort((a, b) => {
      const av = a.front.verified_until
      const bv = b.front.verified_until
      if (av !== bv) {
        if (av === undefined) return -1
        if (bv === undefined) return 1
        const cmp = Date.parse(av) - Date.parse(bv)
        if (cmp !== 0) return cmp
      }
      return a.front.id < b.front.id ? -1 : a.front.id > b.front.id ? 1 : 0
    })
    .slice(0, cap)
}

export function undeterminedForJ6(notes: Note[]): Note[] {
  return undeterminedNotes(notes).filter((n) => n.front.status === 'current')
}
