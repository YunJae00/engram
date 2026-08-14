// Point J11 at a REAL Claude Code session and print what it would keep.
// Nothing is written to the vault — this is the "is the judgement any good?"
// check, and the answer for most spans should be "nothing".
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/engine/claude.js'
import { buildJ11 } from '../src/jobs/session-harvest.js'
import { readAgentsMd } from '../src/jobs/prompts.js'
import { collectResult, engineCwd } from '../src/engine/types.js'
import { extractJson } from '../src/engine/types.js'
import { parseSessionSpan, projectOfTranscript, renderSpan } from '../src/sessions.js'
import { vaultPaths } from '../src/vault.js'

const PROJECTS = join(homedir(), '.claude', 'projects')
const dir = process.argv[2] ?? readdirSync(PROJECTS).find((d) => d.includes('chatx'))!
const full = join(PROJECTS, dir)
const file = readdirSync(full)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, m: statSync(join(full, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0]!.f

// The tail is what a running Engram would have just seen appended.
const TAIL_BYTES = Number(process.env.TAIL ?? 2_000_000)
const raw = readFileSync(join(full, file))
const span = raw.subarray(Math.max(0, raw.length - TAIL_BYTES)).toString('utf8')
const { turns } = parseSessionSpan(span.slice(span.indexOf('\n') + 1))

console.log(`project: ${projectOfTranscript(dir)}`)
console.log(`file:    ${file} (${(raw.length / 1e6).toFixed(1)}MB)`)
console.log(`span:    last ${TAIL_BYTES / 1000}KB → ${turns.length} turns, ${renderSpan(turns).length} chars to the engine\n`)

const adapter = new ClaudeAdapter(240_000)
const { installed, loggedIn } = await adapter.detect()
if (!installed || !loggedIn) {
  console.log('claude not available — parse-only run')
  process.exit(0)
}

const paths = vaultPaths(process.env['ENGRAM_VAULT'] ?? join(homedir(), 'Engram'))
const job = buildJ11(paths, await readAgentsMd(paths), projectOfTranscript(dir), turns)
const reply = await collectResult(adapter, {
  prompt: job.prompt,
  workdir: engineCwd(paths),
  disallowTools: true,
})
const parsed = extractJson(reply) as { notes?: { title: string; body: string }[] }
const notes = parsed?.notes ?? []
console.log(`=== J11이 남기겠다고 한 것: ${notes.length}개 ===\n`)
for (const n of notes) {
  console.log(`## ${n.title}`)
  console.log(n.body.slice(0, 400))
  console.log()
}
