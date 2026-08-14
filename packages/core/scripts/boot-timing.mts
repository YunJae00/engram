// Where does startup time actually go? Measured against a real vault, in the
// order main/index.ts pays for it, because "the app is slow" needs numbers
// before it needs fixes.
import { buildIndex } from '../src/search.js'
import { detectAvailableEngines } from '../src/engine/registry.js'
import { loadAliasGroups } from '../src/aliases.js'
import { loadNotes } from '../src/notes.js'
import { vaultPaths } from '../src/vault.js'

const VAULT = process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram'
const paths = vaultPaths(VAULT)
const t0 = Date.now()
const mark = (label: string, started: number, extra = '') =>
  console.log(label.padEnd(20), String(Date.now() - started).padStart(6) + 'ms', extra)

let t = Date.now()
const notes = await loadNotes(paths)
mark('loadNotes', t, `| ${notes.length} notes`)

t = Date.now()
buildIndex(notes)
mark('buildIndex', t)

t = Date.now()
await loadAliasGroups(paths)
mark('loadAliasGroups', t)

// This one blocks openVaultContext — the shell cannot paint until it returns.
t = Date.now()
const engines = await detectAvailableEngines('claude', {})
mark('detectEngines', t, `| ${engines.length} available`)

console.log('-'.repeat(46))
mark('TOTAL before paint', t0)
