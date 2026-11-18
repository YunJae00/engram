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

const OLD_RULES = await readFile(`${paths.workspace}/AGENTS.md`, 'utf8')

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
