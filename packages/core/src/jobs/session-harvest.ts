import { createHash } from 'node:crypto'
import { writeCapture } from '../capture.js'
import { extractJson } from '../engine/types.js'
import { renderSpan, type SessionTurn } from '../sessions.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

// J11 — watch the user work and keep only what they will need later.
//
// This is the job that decides what a permanent memory is, so its whole design
// is a bias toward keeping NOTHING. The measured shape of this user's vault is
// the argument: notes that record progress are recalled 26% of the time, facts
// and decisions 44-57%. A harvester that writes down "currently trying X"
// converts a memory into a log, and a log is what made them stop opening it.
//
// So the instruction spends most of its length on refusals, and returning an
// empty list is stated as the ordinary outcome rather than a failure.
export const J11_INSTRUCTION = [
  "Below is a stretch of a work session the user just had with an AI assistant. Pick out ONLY what will be needed again later and turn it into notes.",
  "",
  "**Most stretches contain nothing worth keeping. That is normal.** When there is nothing, output {\"notes\": []} — an empty result is not a failure.",
  "",
  "KEEP:",
  "- **decisions and their reasons** — what was chosen, what was rejected, why.",
  "- **findings** — causes, constraints, how someone else’s system actually behaves.",
  "- **traps that will recur** — the \"check this first next time\" earned the hard way.",
  "- **anything the user explicitly asked to remember.**",
  "",
  "DO NOT KEEP:",
  "- **progress** — \"X done\", \"Y in progress\", \"Z is next\". Dead within days.",
  "- **things still being tried** — no conclusion yet. It keeps when it concludes.",
  "- **tool traces** — which files were read, which commands were run.",
  "- **the code itself** — code lives in the repository. What keeps is the judgement about it.",
  "- **general knowledge** — anything true regardless of this user’s situation.",
  "- When unsure, do not keep it. A missed memory can be picked up later; accumulated junk makes the whole vault untrustworthy.",
  "",
  "Output only JSON: {\"notes\":[{\"title\":\"...\",\"body\":\"...\"}]}",
  "- title: one line. The user must recognize it from a list months later.",
  "- body: markdown. **Do not summarize the conversation — state what was learned.** Not \"the user asked and I answered\", but the fact itself.",
  "- Only what was actually in the conversation. Invent nothing.",
  "- Write in the language the user was writing in.",
].join('\n')

export interface HarvestedNote {
  title: string
  body: string
}

// Enough of a fingerprint that re-running over the same conversation is a
// journal skip, while genuinely new turns are new work.
function spanDigest(turns: SessionTurn[]): string {
  const first = turns[0]
  const last = turns[turns.length - 1]
  return createHash('sha1')
    .update(`${turns.length}|${first?.at ?? ''}|${last?.at ?? ''}|${last?.text.slice(0, 200) ?? ''}`)
    .digest('hex')
    .slice(0, 12)
}

function alreadyKeptSection(kept: string[]): string {
  if (kept.length === 0) return ''
  return [
    '',
    '## Already kept from this conversation',
    ...kept.map((title) => `- ${title}`),
    '',
    '**Do not write any of the above again.** Not even reworded — that turns one conclusion into two notes, and the librarian will then ask the user which of them is right.',
    'Keep only what was **newly concluded in this stretch**. When nothing new concluded, an empty array is the correct answer.',
    'If something above turned out to be **wrong** in this stretch, keep only that as a correction note: prefix the title with "Correction: " and open the body with what was wrong and how.',
  ].join('\n')
}

export function buildJ11(
  paths: VaultPaths,
  agentsMd: string,
  project: string,
  turns: SessionTurn[],
  alreadyKept: string[] = [],
  onKept?: (title: string) => void,
): JobSpec {
  return {
    kind: 'J11',
    disallowTools: true,
    // Judgement, not mechanics: a cheap model here writes down the progress
    // updates this job exists to refuse.
    modelHint: 'default',
    inputKey: `${project}:${spanDigest(turns)}`,
    ...withPrompt(agentsMd, 'J11', J11_INSTRUCTION + alreadyKeptSection(alreadyKept), {
      project,
      conversation: renderSpan(turns),
    }),
    async apply(result) {
      const parsed = extractJson(result) as { notes?: HarvestedNote[] }
      const notes = Array.isArray(parsed?.notes) ? parsed.notes : []
      if (notes.length === 0) return ['nothing worth keeping']
      const effects: string[] = []
      for (const note of notes) {
        const title = String(note?.title ?? '').trim()
        const body = String(note?.body ?? '').trim()
        if (!title || !body) continue
        // Into the inbox, exactly like a hand-typed capture — from here the
        // ordinary pipeline absorbs, links and files it. Nothing about a
        // harvested memory is special once it exists.
        // 'session': the machine's own summary of a conversation nobody asked
        // it to read. That marker is what later lets the librarian tidy these
        // without asking, while never touching a note the user actually wrote.
        // `project` is the folder the session was living in ("strata",
        // "novel") — the one word that later tells a topic called "Team"
        // apart from every other Team the user has ever worked near.
        const { file, duplicate } = await writeCapture(paths.inbox, `# ${title}\n\n${body}\n`, 'session', project)
        // Overlapping spans can surface the same conclusion twice; writeCapture
        // already recognises an identical pending capture.
        if (duplicate) continue
        // Told to the caller so the NEXT harvest of this same conversation
        // knows this one exists. Recorded even though the note is not written
        // yet — J1 turns the capture into a note asynchronously, and waiting
        // for that would leave open the window where the duplicate is written.
        onKept?.(title)
        effects.push(`harvested from session: ${title} → inbox/${file}`)
      }
      return effects.length > 0 ? effects : ['nothing worth keeping']
    },
  }
}
