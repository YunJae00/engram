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

console.log(`샘플 볼트 생성: ${root}`)
console.log(`노트 ${notes.length}개\n`)

const header = ['배지', 'id', 'status', 'timeline', 'happened_at', '제목', '체인']
const rows = notes.map((n) => {
  const chain = chainOf(graph, n.front.id)
  const chainLabel =
    chain.length > 1 ? chain.map((c) => c.front.id.replace(/^n-/, '')).join(' → ') : '-'
  return [
    badgeOf(n),
    n.front.id,
    n.front.status,
    n.front.timeline,
    n.front.happened_at ?? '(미정)',
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
console.log(`\n연대 미정 트레이: ${tray.map((n) => n.front.id).join(', ') || '(없음)'}`)
const inversions = detectInversions(notes)
console.log(`supersede-연대 역전: ${inversions.length === 0 ? '(없음)' : JSON.stringify(inversions)}`)
