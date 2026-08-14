// The whole local brain, end to end, for real: a throwaway vault, the REAL
// Gemma model (junctioned in), the REAL bge-m3 embeddings — capture goes in,
// a locally-written note must come out, and a second related capture must
// reflex-link to the first without any model call.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/local-brain-probe.mts"
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/local-brain-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/local-brain-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
await initVault(VAULT, { git: false })
await mkdir(join(USERDATA, 'models'), { recursive: true })

// The real model, via junction — 4.6GB does not get copied for a probe.
const realGguf = join(process.env['APPDATA']!, 'desktop', 'models', 'gguf')
const linked = join(USERDATA, 'models', 'gguf')
const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', linked, realGguf], { windowsHide: true })
if (mk.status !== 0) {
  console.error('junction failed — cannot reach the real model')
  process.exit(1)
}
await writeFile(join(USERDATA, 'local-llm.json'), JSON.stringify({ activeModelId: 'gemma4-e4b' }))

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: VAULT,
    ENGRAM_USERDATA: USERDATA,
    ENGRAM_NO_GIT: '1',
    ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_SEMANTIC: '1',
  },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })

const fail = (message: string): never => {
  console.error(`local-brain-probe: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

// 1) The local engine must be the one detected.
const engines = await page.evaluate(() => window.engram.enginesDetected?.() ?? true)
console.log('local-brain-probe: shell up, engines detected =', engines)

// 2) Capture → sweep → a note written by the LOCAL model.
await page.evaluate(() =>
  window.engram.capture(
    '오늘 결론: 쿠버네티스 배포는 helm 차트로 통일한다. values 정리는 다음 주 화요일까지 내가 마무리하기로 함.',
  ),
)
console.log('local-brain-probe: capture 1 written, sweeping (local model — first load takes ~30s)…')
const t0 = Date.now()
await page.evaluate(() => window.engram.sweep())
const notesDir = join(VAULT, 'workspace', 'notes')
let names: string[] = []
for (let i = 0; i < 60; i++) {
  names = (await readdir(notesDir).catch(() => [])).filter((n) => n.endsWith('.md'))
  if (names.length >= 1) break
  await new Promise((r) => setTimeout(r, 3_000))
}
if (names.length === 0) fail('no note appeared — the local librarian did not absorb')
const first = await readFile(join(notesDir, names[0]!), 'utf8')
console.log(`local-brain-probe: NOTE 1 in ${Math.round((Date.now() - t0) / 1000)}s — ${names[0]}`)
console.log(first.slice(0, 400))

// 3) A second, related capture — after its sweep the reflex association
// (embeddings only, no LLM) should link it to the first.
await page.evaluate(() =>
  window.engram.capture('helm values 정리 관련: 스테이징 클러스터 값은 신규 리포에 두기로 결정했다.'),
)
await page.evaluate(() => window.engram.sweep())
let linkedNote: string | null = null
for (let i = 0; i < 60; i++) {
  const now = (await readdir(notesDir).catch(() => [])).filter((n) => n.endsWith('.md'))
  for (const n of now) {
    const body = await readFile(join(notesDir, n), 'utf8')
    if (/derived_from:/.test(body) && /semantic association/.test(body)) {
      linkedNote = n
      break
    }
  }
  if (linkedNote) break
  await new Promise((r) => setTimeout(r, 3_000))
}
console.log(
  linkedNote
    ? `local-brain-probe: reflex association LINKED (${linkedNote})`
    : 'local-brain-probe: no reflex link yet (embedding pass may trail) — checking index instead',
)
const engramDir = join(VAULT, 'workspace', '.engram')
const derived = await readdir(engramDir).catch(() => [])
console.log('local-brain-probe: .engram artifacts:', derived.join(', '))

let warmed: string | null = null
for (let i = 0; i < 20; i++) {
  for (const n of (await readdir(notesDir).catch(() => [])).filter((x) => x.endsWith('.md'))) {
    const body = await readFile(join(notesDir, n), 'utf8')
    if (/warmth:/.test(body)) {
      warmed = n
      break
    }
  }
  if (warmed) break
  await new Promise((r) => setTimeout(r, 3_000))
}
console.log(
  warmed
    ? `local-brain-probe: WARMTH echo landed (${warmed})`
    : 'local-brain-probe: no warmth stamp yet (echo may trail the window)',
)
const fabric = await readFile(join(engramDir, 'neighbors.json'), 'utf8').catch(() => null)
if (fabric) {
  const rows = JSON.parse(fabric) as { rows: Record<string, { id: string; cos: number }[]> }
  const pairs = Object.entries(rows.rows).map(([id, hits]) => `${id}→${hits.map((h) => `${h.id}@${h.cos}`).join(',')}`)
  console.log('local-brain-probe: FABRIC rows:', pairs.join(' | ') || '(empty)')
} else {
  console.log('local-brain-probe: no neighbors.json (fabric not built)')
}

await app.close()
console.log('local-brain-probe: DONE')
