import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { freshnessOf } from '../freshness.js'
import type { Note } from '../schema.js'
import { noteTitle } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { looksLikeBriefRefusal, stripBriefBody } from './librarian.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

const digestHash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)

const WEEK_MS = 7 * 86_400_000
const RECENT_CAP = 30
const COOLING_CAP = 10
const ORPHAN_CAP = 10

function summary(n: Note) {
  return { id: n.front.id, title: noteTitle(n), type: n.front.type, excerpt: n.body.slice(0, 160) }
}

// The digest's evidence, assembled deterministically (zero token cost):
// the week's touched notes, the cooling ones, the never-linked orphans and the
// topic hubs that exist so far. Empty `recent` = an idle week = no digest.
export function digestInput(notes: Note[], now: Date) {
  const current = notes.filter((n) => n.front.status === 'current')
  const weekAgo = now.getTime() - WEEK_MS
  const recent = current
    .filter((n) => n.front.type !== 'hub' && Date.parse(n.front.updated) > weekAgo)
    .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    .slice(0, RECENT_CAP)

  const cooling = current
    .filter((n) => freshnessOf(n, now) !== 'fresh')
    .sort((a, b) => (a.front.verified_until ?? '').localeCompare(b.front.verified_until ?? ''))
    .slice(0, COOLING_CAP)
    .map((n) => ({ ...summary(n), verified_until: n.front.verified_until }))

  const linked = new Set<string>()
  for (const n of current) {
    for (const rel of n.front.derived_from) {
      linked.add(n.front.id)
      linked.add(rel)
    }
  }
  const orphans = current
    .filter((n) => n.front.type !== 'hub' && !linked.has(n.front.id))
    .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    .slice(0, ORPHAN_CAP)
    .map(summary)

  const hubs = current.filter((n) => n.front.type === 'hub').map((n) => noteTitle(n))
  return { week_of: now.toISOString().slice(0, 10), recent: recent.map(summary), cooling, orphans, hubs }
}

const J10_INSTRUCTION = [
  "Summarize the past week of vault activity as a weekly digest. Output markdown only, 200 words or fewer.",
  "Write in the language of the vault notes — follow the language of the input note titles.",
  "Use exactly this shape (drop any section whose input is empty):",
  "",
  "# Weekly digest",
  "",
  "## What accumulated",
  "<3-6 bullets synthesizing the recent notes BY TOPIC, not as a list of titles. Say what moved and how far it got.>",
  "",
  "## Cooling off",
  "- **<title>** — <one line on why it needs a check>",
  "",
  "## Never connected",
  "<one line per orphan note: - **<title>** — <which existing topic or hub it could attach to, or whether it really is its own subject>>",
  "",
  "Translate the four headings into the notes’ language when the notes are not English; keep them as written when they are.",
  "Forbidden: tables, apologies, any mention of the input/tools/file saving, sections other than the headings above, code fences.",
].join('\n')

export function buildJ10(paths: VaultPaths, agentsMd: string, input: ReturnType<typeof digestInput>, now: Date): JobSpec {
  const date = now.toISOString().slice(0, 10)
  return {
    kind: 'J10',
    disallowTools: true,
    modelHint: 'default', // user-facing synthesis prose — smart model
    inputKey: `${date}:${digestHash(JSON.stringify(input))}`,
    ...withPrompt(agentsMd, 'J10', J10_INSTRUCTION, input),
    async apply(result) {
      const body = stripBriefBody(result)
      if (!body || looksLikeBriefRefusal(body)) throw new Error('J10: engine returned a refusal instead of digest markdown')
      const file = join(paths.views, `digest-${date}.md`)
      await writeFile(file, body + '\n')
      return [`weekly digest written: _views/digest-${date}.md`]
    },
  }
}
