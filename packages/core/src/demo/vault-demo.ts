import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { badgeOf } from '../freshness.js'
import { buildLineage, chainOf, detectInversions } from '../lineage.js'
import { loadNotes } from '../notes.js'
import { noteTitle } from '../schema.js'
import { generateSampleVault } from '../sample-vault.js'
import { undeterminedNotes } from '../chronology.js'

// `pnpm --filter core demo:vault` — regenerates fixtures/sample-vault and
// prints chain/badge state as a table (M1 acceptance).
const root = resolve(process.argv[2] ?? '../../fixtures/sample-vault')

await rm(root, { recursive: true, force: true })
const { paths } = await generateSampleVault(root)
const notes = await loadNotes(paths)
const graph = buildLineage(notes)

console.log(`sample vault created: ${root}`)
console.log(`${notes.length} notes
`)

const header = ['badge', 'id', 'status', 'timeline', 'happened_at', 'title', 'chain']
const rows = notes.map((n) => {
  const chain = chainOf(graph, n.front.id)
  const chainLabel =
    chain.length > 1 ? chain.map((c) => c.front.id.replace(/^n-/, '')).join(' → ') : '-'
  return [
    badgeOf(n),
    n.front.id,
    n.front.status,
    n.front.timeline,
    n.front.happened_at ?? '(unset)',
    noteTitle(n),
    chainLabel,
  ]
})
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
const line = (cells: string[]) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i]!)).join(' | ') + ' |'
console.log(line(header))
console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|')
for (const row of rows) console.log(line(row))

const tray = undeterminedNotes(notes)
console.log(`\nundated tray: ${tray.map((n) => n.front.id).join(', ') || '(none)'}`)
const inversions = detectInversions(notes)
console.log(`supersede chronology inversions: ${inversions.length === 0 ? '(none)' : JSON.stringify(inversions)}`)
