// What would a Claude session actually receive? Print it verbatim — this text
// is injected before every prompt, so its size and usefulness are the product.
import { buildContextBlock } from '../src/context-block.js'
import { loadNotes } from '../src/notes.js'
import { vaultPaths } from '../src/vault.js'

const notes = await loadNotes(vaultPaths(process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram'))
const block = buildContextBlock(notes)
console.log(block)
console.log('\n' + '-'.repeat(60))
console.log(`${notes.length} notes → ${block.length} chars, ${block.split('\n').length} lines`)
