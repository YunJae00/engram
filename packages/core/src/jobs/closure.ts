import { createHash } from 'node:crypto'
import { createCard, listCards } from '../cards.js'
import { extractJson } from '../engine/types.js'
import { openLoops } from '../loops.js'
import { readNote, writeNote } from '../notes.js'
import type { Note } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

// A handful of loops and a handful of fresh conclusions fit one judgment call.
// Caps keep the prompt bounded on vaults with a long tail of undated loops.
const LOOP_CAP = 20
const CONCLUSION_CAP = 10

export interface ClosureInput {
  loops: Note[]
  conclusions: Note[]
}

// Deterministic candidate selection, pure so it is testable without a vault.
// Loops: the open ones, most urgent first, minus those already asked about —
// a pending closure card means the question exists; re-judging it every sweep
// would burn tokens to rediscover it. Conclusions: session-origin notes new
// since the last sweep — the only notes that can contain "it happened", and
// the origin filter is what keeps the user's own notes from being read as
// evidence (a user note claiming something is done IS the loop's business,
// but it is the user saying so, and they can close their own loop).
export function closureCandidates(
  notes: Note[],
  cardedLoops: ReadonlySet<string>,
  since: string | null,
  now: Date,
): ClosureInput {
  const loops = openLoops(notes, now)
    .filter((n) => !cardedLoops.has(n.front.id))
    .slice(0, LOOP_CAP)
  const floor = since === null ? null : Date.parse(since)
  const conclusions = notes
    .filter((n) => n.front.origin === 'session' && n.front.status === 'current')
    .filter((n) => floor === null || Date.parse(n.front.created) > floor)
    .sort((a, b) => Date.parse(b.front.created) - Date.parse(a.front.created))
    .slice(0, CONCLUSION_CAP)
  return { loops, conclusions }
}

const INSTRUCTION = [
  "Below, `loops` are pieces of work that are not finished, and `conclusions` are new findings just harvested from a work session.",
  "Decide which conclusion closes which loop.",
  "",
  "CLOSES = the conclusion states that the very thing the loop was waiting for has happened:",
  "- the completion, release, merge or resolution the loop waited for is recorded in the conclusion",
  "- the decision the loop waited for was made, and the conclusion records that decision",
  "",
  "DOES NOT CLOSE (the common traps):",
  "- in progress, partially done, a plan was made — it moved, it did not finish",
  "- it merely touches the same topic without mentioning the thing the loop demands",
  "- only part of the loop is done — while the other half still wants something, the loop lives",
  "",
  "Close only when certain. When unsure, not closing is the right answer — a wrongly closed loop becomes a forgotten promise.",
  "",
  "Output only JSON: {\"closures\":[{\"loop\":\"<loop id>\",\"closed_by\":\"<conclusion id>\",\"reason\":\"<one line>\"}]}",
  "When nothing closes, {\"closures\":[]}.",
].join('\n')

interface Verdict {
  closures?: { loop?: string; closed_by?: string; reason?: string }[]
}

export function buildJ13(paths: VaultPaths, agentsMd: string, input: ClosureInput, now: Date): JobSpec {
  const { loops, conclusions } = input
  const loopById = new Map(loops.map((n) => [n.front.id, n]))
  const conclusionById = new Map(conclusions.map((n) => [n.front.id, n]))
  const inputKey = createHash('sha1')
    .update([...loops.map((n) => n.front.id).sort(), '|', ...conclusions.map((n) => n.front.id).sort()].join('\n'))
    .digest('hex')
  return {
    kind: 'J13',
    disallowTools: true,
    // Same reasoning as J12: a cheap model would close loops that merely moved.
    modelHint: 'default',
    inputKey,
    ...withPrompt(agentsMd, 'J13', INSTRUCTION, {
      loops: loops.map((n) => ({
        id: n.front.id,
        created: n.front.created,
        due_at: n.front.due_at,
        body: n.body.slice(0, 700),
      })),
      conclusions: conclusions.map((n) => ({ id: n.front.id, created: n.front.created, body: n.body.slice(0, 1000) })),
    }),
    apply: async (result) => {
      const parsed = extractJson(result) as Verdict
      const effects: string[] = []
      for (const c of Array.isArray(parsed.closures) ? parsed.closures : []) {
        const loop = c.loop ? loopById.get(c.loop) : undefined
        const evidence = c.closed_by ? conclusionById.get(c.closed_by) : undefined
        // Every guard here exists because this path ends in a frontmatter
        // write: invented ids, a note closing itself, or "evidence" older than
        // the promise it claims to fulfil are all engine hallucinations.
        if (!loop || !evidence) continue
        if (loop.front.id === evidence.front.id) continue
        if (Date.parse(evidence.front.created) <= Date.parse(loop.front.created)) continue
        if (loop.front.origin === 'session') {
          // The machine's own loop: close it, say so in the journal. Re-read
          // from disk — the sweep may have touched the note since candidates
          // were selected, and isOpenLoop's authority belongs to the fresh copy.
          const fresh = await readNote(paths, loop.front.id).catch(() => null)
          if (!fresh || fresh.front.open_loop !== true || fresh.front.status !== 'current') continue
          fresh.front.open_loop = false
          fresh.front.updated = now.toISOString()
          await writeNote(paths, fresh)
          effects.push(`loop closed: ${loop.front.id} ← ${evidence.front.id} (${c.reason ?? ''})`)
        } else {
          // The user's loop: their promise, their click. createCard dedups a
          // repeat proposal, so a re-run cannot stack questions.
          const card = await createCard(
            paths,
            {
              cardType: 'closure',
              targets: [loop.front.id],
              rationale: c.reason ?? 'a session conclusion appears to close this loop',
              proposed: evidence.front.id,
              job: 'J13',
            },
            now,
          )
          effects.push(`closure proposed: ${loop.front.id} ← ${evidence.front.id} (${card.id})`)
        }
      }
      return effects.length > 0 ? effects : ['no loops to close']
    },
  }
}

// The pending closure questions, so candidate selection can skip loops the
// user is already being asked about. A set, because sweep asks per loop id.
export async function cardedClosureTargets(paths: VaultPaths): Promise<Set<string>> {
  return new Set(
    (await listCards(paths, 'proposed')).filter((c) => c.cardType === 'closure').flatMap((c) => c.targets),
  )
}
