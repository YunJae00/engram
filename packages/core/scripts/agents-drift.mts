import { AGENTS_MD_V1 } from '../src/index.js'
import { readFile } from 'node:fs/promises'

const vault = process.argv[2]
if (!vault) {
  console.error('usage: agents-drift.mts <path to AGENTS.md>')
  process.exit(2)
}
const live = (await readFile(vault, 'utf8')).replace(/\r\n/g, '\n')
const shipped = AGENTS_MD_V1.replace(/\r\n/g, '\n')

if (live === shipped) {
  console.log('identical — the vault is running the rules this build ships')
  process.exit(0)
}

const liveLines = new Set(live.split('\n').map((l) => l.trim()).filter(Boolean))
const shippedLines = shipped.split('\n').map((l) => l.trim()).filter(Boolean)
const missing = shippedLines.filter((l) => !liveLines.has(l))

const shippedSet = new Set(shippedLines)
const extra = [...liveLines].filter((l) => !shippedSet.has(l))

console.log(`live ${live.split('\n').length} lines, shipped ${shipped.split('\n').length} lines\n`)
console.log(`RULES THE CODE SHIPS THAT THIS VAULT NEVER GOT (${missing.length}):`)
for (const line of missing) console.log(`  + ${line.slice(0, 150)}`)
console.log(`\nLINES IN THE VAULT THAT THE CODE NO LONGER SHIPS (${extra.length}):`)
for (const line of extra) console.log(`  - ${line.slice(0, 150)}`)
