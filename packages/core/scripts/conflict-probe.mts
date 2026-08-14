// Does the §3.5 rule actually change what the engine calls a conflict?
//
// A real vault produced 11 open conflict cards. Reading all of them, 8 were the
// same shape — an earlier snapshot of ongoing work against a later one ("not
// fixed yet" vs "fixed", "automation absent" vs "automation landed") — and only
// 3 were claims that cannot both be true at a single point in time. The
// instruction never drew that line, and §3 said the fallback under uncertainty
// was a conflict card, so the model was doing exactly as told.
//
// This replays the REAL pairs through J3 under the old rulebook and the new one
// and counts. A rule that reads well and changes nothing is worth nothing.
//
// Nothing is written: the job's prompt is run directly, `apply` never called.
import { readFile } from 'node:fs/promises'
import { AGENTS_MD_V1 } from '../src/agents-template.js'
import { createEngine } from '../src/engine/registry.js'
import { engineCwd } from '../src/engine/types.js'
import { buildJ3 } from '../src/jobs/librarian.js'
import { readNote } from '../src/notes.js'
import type { Note } from '../src/schema.js'
import { vaultPaths } from '../src/vault.js'

const paths = vaultPaths(process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram')
const engine = createEngine('claude')

// The pairs that produced a conflict card, straight off disk.
const PAIRS = [
  ['n-ms6wzzk9-8ep11u', 'n-mrx7y2ky-7m0eea'],
  ['n-ms6vzor3-1bwm4i', 'n-mrxl0hby-ey851y'],
  ['n-ms5rxgb6-fr6ukh', 'n-ms5qxi0c-b01v6t'],
  ['n-ms6upwr6-2qfmfy', 'n-ms5rxgb6-64yzpg'],
  ['n-ms5u4c9x-908av2', 'n-ms5ssbvv-ragici'],
  ['n-ms6vv77t-c30xq8', 'n-ms6tclr2-yilnxk'],
  ['n-ms5rxgb6-0bvzvn', 'n-ms4kn9hg-mh7ove'],
  ['n-ms6x1xoj-r3y6jd', 'n-ms6x3p28-166trl'],
  ['n-ms6vihrf-q57k1a', 'n-ms6tclr2-x3jh6z'],
  ['n-ms6wkxw4-of8d59', 'n-ms6vv77t-h9f5b5'],
]

// The rulebook as it stands in this vault today, so "before" is the instruction
// that actually produced those cards — not a reconstruction of it.
const OLD_RULES = await readFile(`${paths.workspace}/AGENTS.md`, 'utf8')

// ONE call per rulebook, with the whole set as delta-vs-corpus — the shape the
// sweep actually runs. Asking pair-by-pair was the first attempt and it was
// dishonest: the old rulebook only re-raised 3 of the 10 conflicts it had
// really produced, because a pair seen alone is a different question from a
// pair seen among sixty notes. A baseline that cannot reproduce the bug cannot
// measure the fix.
async function conflictsRaised(rules: string, delta: Note[], corpus: Note[]): Promise<string[][]> {
  const job = buildJ3(paths, rules, delta, corpus, new Date())
  let text = ''
  for await (const event of engine.run({
    prompt: job.prompt,
    workdir: engineCwd(paths),
    disallowTools: true,
    modelHint: job.modelHint,
  })) {
    if (event.type === 'result') text = event.text
    else if (event.type === 'error') throw new Error(event.message)
  }
  const json = /\{[\s\S]*\}/.exec(text)
  if (!json) return []
  try {
    const parsed = JSON.parse(json[0]) as { cards?: { cardType?: string; targets?: string[] }[] }
    return (parsed.cards ?? []).filter((c) => c.cardType === 'conflict').map((c) => c.targets ?? [])
  } catch {
    return []
  }
}

const title = (n: Note) => (n.body.split('\n').find((l) => l.startsWith('#')) ?? n.front.id).replace(/^#+\s*/, '')

// Newer note of each pair is the "delta"; the older is the standing corpus.
const newer: Note[] = []
const older: Note[] = []
for (const [a, b] of PAIRS) {
  older.push(await readNote(paths, a!))
  newer.push(await readNote(paths, b!))
}
const byId = new Map([...older, ...newer].map((n) => [n.front.id, n]))
const name = (id: string) => {
  const n = byId.get(id)
  return n ? title(n).slice(0, 30) : id
}

for (const [label, rules] of [
  ['old rulebook', OLD_RULES],
  ['new rulebook', AGENTS_MD_V1],
] as const) {
  const raised = await conflictsRaised(rules, newer, older)
  console.log(`\n${label}: ${raised.length} conflict(s) — the user would be asked ${raised.length} question(s)`)
  for (const targets of raised) console.log(`   ASK  ${targets.map(name).join(' ⟷ ')}`)
}
