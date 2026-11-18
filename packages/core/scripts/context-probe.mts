import { buildContextBlock } from '../src/context-block.js'
import { loadNotes } from '../src/notes.js'
import { vaultPaths } from '../src/vault.js'

const notes = await loadNotes(vaultPaths(process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram'))
const block = buildContextBlock(notes)
console.log(block)
console.log('\n' + '-'.repeat(60))
console.log(`${notes.length} notes → ${block.length} chars, ${block.split('\n').length} lines`)
