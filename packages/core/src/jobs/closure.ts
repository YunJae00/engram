import { createHash } from 'node:crypto'
import { createCard, listCards } from '../cards.js'
import { extractJson } from '../engine/types.js'
import { openLoops } from '../loops.js'
import { readNote, writeNote } from '../notes.js'
import type { Note } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

const LOOP_CAP = 20
const CONCLUSION_CAP = 10

interface ClosureInput {
  loops: Note[]
  conclusions: Note[]
}

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
        if (!loop || !evidence) continue
        if (loop.front.id === evidence.front.id) continue
        if (Date.parse(evidence.front.created) <= Date.parse(loop.front.created)) continue
        if (loop.front.origin === 'session') {
          const fresh = await readNote(paths, loop.front.id).catch(() => null)
          if (!fresh || fresh.front.open_loop !== true || fresh.front.status !== 'current') continue
          fresh.front.open_loop = false
          fresh.front.updated = now.toISOString()
          await writeNote(paths, fresh)
          effects.push(`loop closed: ${loop.front.id} ← ${evidence.front.id} (${c.reason ?? ''})`)
        } else {
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

export async function cardedClosureTargets(paths: VaultPaths): Promise<Set<string>> {
  return new Set(
    (await listCards(paths, 'proposed')).filter((c) => c.cardType === 'closure').flatMap((c) => c.targets),
  )
}
