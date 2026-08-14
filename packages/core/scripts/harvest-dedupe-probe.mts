import { buildJ11, createEngine, engineCwd, extractJson, initVault, parseSessionSpan } from '../src/index.js'
import { mkdir, mkdtemp, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = 'C--Users-ykwon060-Desktop-pjt-strata-strata'
const DIR = join(homedir(), '.claude', 'projects', PROJECT)

// The biggest transcript in this project is this conversation.
const files = await readdir(DIR)
let biggest = { file: '', size: 0 }
for (const name of files) {
  if (!name.endsWith('.jsonl')) continue
  const info = await stat(join(DIR, name)).catch(() => null)
  if (info && info.size > biggest.size) biggest = { file: join(DIR, name), size: info.size }
}
if (!biggest.file) throw new Error('no transcript found')

// Read a window out of the middle — a real span, not the whole 30MB.
const WINDOW = 3 * 1024 * 1024
const from = Math.max(0, biggest.size - WINDOW)
const handle = await open(biggest.file, 'r')
const buffer = Buffer.alloc(Math.min(WINDOW, biggest.size - from))
await handle.read(buffer, 0, buffer.length, from)
await handle.close()
const { turns } = parseSessionSpan(buffer.toString('utf8'))
// Drop the first turn: reading from an arbitrary offset can clip it.
const span = turns.slice(1, 60)
console.log(`transcript ${(biggest.size / 1048576).toFixed(1)}MB → ${span.length} turns of conversation\n`)

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const paths = await initVault(await mkdtemp(join(REPO_TMP, 'harvestprobe-')), { git: false })
const engine = createEngine('claude')

async function harvest(kept: string[]): Promise<string[]> {
  const job = buildJ11(paths, '', 'strata', span, kept)
  let text = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let failed = ''
    for await (const event of engine.run({
      prompt: job.prompt,
      workdir: engineCwd(paths),
      disallowTools: true,
      modelHint: job.modelHint,
    })) {
      if (event.type === 'result') text = event.text
      else if (event.type === 'error') failed = event.message
    }
    if (!failed) break
    if (attempt === 3) throw new Error(failed)
    await new Promise((r) => setTimeout(r, attempt * 15_000))
  }
  const parsed = extractJson(text) as { notes?: { title?: string }[] }
  return (parsed.notes ?? []).map((n) => String(n?.title ?? '').trim()).filter(Boolean)
}

console.log('PASS 1 — blind, exactly what ships today')
const first = await harvest([])
for (const t of first) console.log(`   + ${t}`)
console.log(`   ${first.length} note(s)\n`)

console.log('PASS 2 — same span, told what pass 1 kept')
const second = await harvest(first)
for (const t of second) console.log(`   + ${t}`)
console.log(`   ${second.length} note(s)\n`)

// Today the second pass writes the same conclusions again in new words, and
// those become the questions. Anything it emits now should be genuinely new.
const repeats = second.filter((t) => first.some((f) => f === t))
console.log(`identical titles repeated: ${repeats.length}`)
console.log(`duplicate notes the vault is spared: ${first.length} → ${second.length}`)
if (second.length === 0) console.log('\nsecond pass stayed silent — nothing to contradict')
else console.log('\nsecond pass still wrote:', second.join(' | '))
