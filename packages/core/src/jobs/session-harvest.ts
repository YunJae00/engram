import { createHash } from 'node:crypto'
import { writeCapture } from '../capture.js'
import { extractJson } from '../engine/types.js'
import { renderSpan, type SessionTurn } from '../sessions.js'
import type { VaultPaths } from '../vault.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

export const J11_INSTRUCTION = [
  "Below is a stretch of a work session the user just had with an AI assistant. Pick out ONLY what will be needed again later and turn it into notes.",
  "",
  "**Most stretches contain nothing worth keeping. That is normal.** When there is nothing, output {\"notes\": []} — an empty result is not a failure.",
  "",
  "KEEP:",
  "- **decisions and their reasons** — what was chosen, what was rejected, why.",
  "- **findings** — causes, constraints, how someone else’s system actually behaves.",
  "- **completed work outcomes** — a concrete fix, delivered change or verified result useful in a daily work report. Preserve the activity date from the transcript timestamps. Distinguish observed results from the assistant's unverified claims.",
  "- **traps that will recur** — the \"check this first next time\" earned the hard way.",
  "- **anything the user explicitly asked to remember.**",
  "",
  "DO NOT KEEP:",
  "- **transient progress** — repeated status updates, unfinished attempts and plans without a concrete outcome. Never turn a plan or a failed test into completed work.",
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
    modelHint: 'default',
    inputKey: `${project}:${spanDigest(turns)}`,
    ...withPrompt(agentsMd, 'J11', J11_INSTRUCTION + alreadyKeptSection(alreadyKept), {
      project,
      conversation: renderSpan(turns),
    }),
    async apply(result) {
      const parsed = extractJson(result) as { notes?: HarvestedNote[] }
      if (!Array.isArray(parsed?.notes) || parsed.notes.some(note =>
        !note || typeof note.title !== 'string' || !note.title.trim() || typeof note.body !== 'string' || !note.body.trim()))
        throw new Error('Invalid session harvest response: expected a notes array with non-empty titles and bodies')
      const notes = parsed.notes
      if (notes.length === 0) return ['nothing worth keeping']
      const effects: string[] = []
      for (const note of notes) {
        const title = String(note?.title ?? '').trim()
        const body = String(note?.body ?? '').trim()
        if (!title || !body) continue
        const { file, duplicate } = await writeCapture(paths.inbox, `# ${title}\n\n${body}\n`, 'session', project)
        if (duplicate) continue
        onKept?.(title)
        effects.push(`harvested from session: ${title} → inbox/${file}`)
      }
      return effects.length > 0 ? effects : ['nothing worth keeping']
    },
  }
}
