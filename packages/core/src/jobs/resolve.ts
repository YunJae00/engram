import { approveCard, holdCard, listCards, rejectCard, type Card } from '../cards.js'
import { extractJson } from '../engine/types.js'
import { readNote } from '../notes.js'
import type { Note } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

function isMachineWritten(note: Note): boolean {
  return note.front.origin === 'session'
}

// Cards worth attempting. `stale` and `new-note` are excluded for opposite
// reasons: stale is a question about the world (is this still true?) that no
// amount of reading two bodies can answer, and new-note has no targets to
// judge provenance from.
const RESOLVABLE = new Set(['conflict', 'merge', 'supersede'])

export interface ResolvableCard {
  card: Card
  notes: Note[]
}

export async function resolvableCards(paths: VaultPaths): Promise<ResolvableCard[]> {
  const out: ResolvableCard[] = []
  for (const card of await listCards(paths, 'proposed')) {
    if (!RESOLVABLE.has(card.cardType)) continue
    if (card.held) continue // one attempt was the budget — see Card.held
    if (card.targets.length < 2) continue
    const notes: Note[] = []
    for (const id of card.targets) {
      const note = await readNote(paths, id).catch(() => null)
      if (!note) break
      notes.push(note)
    }
    if (notes.length !== card.targets.length) continue
    out.push({ card, notes })
  }
  return out
}

const INSTRUCTION = [
  "Below are notes from the vault and a question the librarian raised between them.",
  "Asking the person is the last resort — decide whether the two bodies alone let you settle it.",
  "(Notes the person wrote themselves are protected structurally by the system — you only judge the content.)",
  "",
  "**SETTLEABLE** (most cases land here):",
  "- the same thing written twice in different words → fold into one",
  "- one is later and more detailed → the later one wins",
  "- one is the state after the other progressed → the later one wins",
  "- one has an obvious mistake and the other is right → the right one wins",
  "",
  "**NOT SETTLEABLE** (only a person knows — escalate only here):",
  "- the same thing measured with different numbers (the bodies do not say which measurement was wrong)",
  "- the same symptom blamed on different causes or environments (the bodies do not say which was meant)",
  "- each is right alone but applying both breaks something (what to give up is the person’s call)",
  "",
  "**BOTH BEING RIGHT IS COMMON.** When they measure different things, or one complements or explains the other, neither may be discarded — it simply was not a contradiction, and only the question needs to go away.",
  "",
  "Start from exactly one test: **is the older note’s claim still true?**",
  "- already false (fixed, adopted, changed) → **resolve**, the later one wins. Leaving a note that became false is not thrift; it misleads every future session that reads it. Detail that lived only in the loser is either already in the winner or no longer worth keeping.",
  "- both true and harmless side by side → **keep-both**",
  "- the bodies cannot decide which is true → **escalate**",
  "",
  "**Both being true can still be an escalate**: when each is right alone but applying both breaks something. keep-both means \"both true AND nothing happens when they sit side by side\". If side by side causes an accident, the person decides what to give up — quietly keeping both would hide that accident from everyone.",
  "",
  "Output only JSON: {\"verdict\":\"resolve\"|\"keep-both\"|\"escalate\",\"winner\":\"<note id>\",\"reason\":\"<one line>\"}",
  "- resolve: the older note is no longer true. `winner` is the id of the note to keep.",
  "- keep-both: never a contradiction, harmless together. Omit `winner`.",
  "- escalate: only a person can answer. Omit `winner`.",
].join('\n')

interface Verdict {
  verdict?: string
  winner?: string
  reason?: string
}

export function buildJ12(
  paths: VaultPaths,
  agentsMd: string,
  entry: ResolvableCard,
  now: Date,
): JobSpec {
  const { card, notes } = entry
  return {
    kind: 'J12',
    disallowTools: true,
    // Judgment: a cheap model here would resolve the ones it should escalate,
    // and a wrong auto-resolve silently loses a memory.
    modelHint: 'default',
    inputKey: card.id,
    ...withPrompt(agentsMd, 'J12', INSTRUCTION, {
      question: { type: card.cardType, rationale: card.rationale },
      notes: notes.map((n) => ({ id: n.front.id, created: n.front.created, body: n.body.slice(0, 2400) })),
    }),
    apply: async (result) => {
      let parsed: Verdict
      try {
        parsed = extractJson(result) as Verdict
      } catch {
        // An unreadable verdict spends the one attempt too — without this a
        // model that answers J12 in prose would re-judge the card every sweep.
        await holdCard(paths, card.id, 'verdict could not be read')
        return [`held quietly: ${card.id} (verdict could not be read)`]
      }
      // "Not a contradiction after all" — the commonest true answer, and the
      // one the first version of this job could not give. Probed against the
      // real vault: a note measuring "64 sessions active in the last 2 hours"
      // and one measuring "2,202 of 2,235 are self-generated" were read as
      // conflicting numbers, when the second note's own last line says it
      // EXPLAINS the first. With only resolve-or-escalate on offer, settling
      // that correctly meant retiring one of them — and the loser held three
      // findings the winner did not. Keeping both is not a compromise here, it
      // is the right answer.
      if (parsed.verdict === 'keep-both') {
        // The two card types need opposite calls to reach the same outcome. On
        // a conflict, approving with 'both' verifies each note and retires
        // neither — and lifts the `disputed` status the card pinned on them,
        // which is what puts them back into the context every session reads.
        // On a merge or supersede the proposal itself is the thing to refuse:
        // approving it would write the merge this verdict just said not to do.
        if (card.cardType === 'conflict') await approveCard(paths, card.id, { choice: 'both', actor: 'librarian' }, now)
        else await rejectCard(paths, card.id, `not a contradiction — both kept: ${parsed.reason ?? ''}`, now, 'librarian')
        return [`not a contradiction: ${card.id} — both kept (${parsed.reason ?? ''})`]
      }
      if (parsed.verdict !== 'resolve') {
        await holdCard(paths, card.id, parsed.reason ?? 'undecidable')
        return [`held quietly: ${card.id} (${parsed.reason ?? 'undecidable'})`]
      }
      const winner = notes.find((n) => n.front.id === parsed.winner)
      // A "winner" that is not one of the targets means the engine invented an
      // id. Hold rather than guess — this path retires notes.
      if (!winner) {
        await holdCard(paths, card.id, 'winner id is not one of the targets')
        return [`held quietly: ${card.id} (winner id is not one of the targets)`]
      }
      const losers = notes.filter((n) => n.front.id !== winner.front.id)
      // THE PROVENANCE LAW, enforced where it bites: the machine never retires
      // what the user wrote. A resolve verdict that would sink a user-written
      // note becomes keep-both — the question still disappears, the memory
      // stays. (Session-written losers retire as judged.)
      if (losers.some((n) => !isMachineWritten(n))) {
        if (card.cardType === 'conflict') await approveCard(paths, card.id, { choice: 'both', actor: 'librarian' }, now)
        else await rejectCard(paths, card.id, `user-written note protected — both kept: ${parsed.reason ?? ''}`, now, 'librarian')
        return [`user note protected: ${card.id} — both kept instead of resolving (${parsed.reason ?? ''})`]
      }
      // approveCard already knows how to retire the other side for each card
      // type; reuse it so the auto path and the human path do the same thing.
      if (card.cardType === 'conflict') {
        await approveCard(paths, card.id, { choice: winner.front.id === notes[0]?.front.id ? 'A' : 'B', actor: 'librarian' }, now)
      } else {
        await approveCard(paths, card.id, { actor: 'librarian' }, now)
      }
      return [
        `auto-settled: ${card.id} [${card.cardType}] → kept ${winner.front.id}, retired ${losers.map((n) => n.front.id).join(', ')} (${parsed.reason ?? ''})`,
      ]
    },
  }
}

