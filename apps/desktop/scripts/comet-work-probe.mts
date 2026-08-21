// The comet as a working colleague, for real: the REAL Gemma model, a vault
// holding today's work and a taught procedure with a blank, and one Korean
// sentence asking for the day's chore. Measures what the 2B actually does in
// the tool loop — which tools it picks, whether it fills the blank, whether
// the submit gate stands between it and the site — and prints the trace.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/comet-work-probe.mts"
import { _electron as electron } from '@playwright/test'
import { addRoutine, createNote, initVault, listCards } from 'core'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import os from 'node:os'

const VAULT = fileURLToPath(new URL('../../../tmp/comet-work-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/comet-work-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(join(USERDATA, 'models'), { recursive: true })

console.log(`comet-work-probe: free memory ${(os.freemem() / 1e9).toFixed(1)}GB`)

// The real model, via junction — gigabytes do not get copied for a probe.
const realGguf = join(process.env['APPDATA']!, 'desktop', 'models', 'gguf')
const linked = join(USERDATA, 'models', 'gguf')
const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', linked, realGguf], { windowsHide: true })
if (mk.status !== 0) {
  console.error('junction failed — cannot reach the real model')
  process.exit(1)
}
await writeFile(join(USERDATA, 'local-llm.json'), JSON.stringify({ activeModelId: 'gemma4-e2b' }))

// A work-log site: a form that records what was posted.
const posted: string[] = []
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  if (req.url?.startsWith('/post')) {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      posted.push(new URLSearchParams(body).get('entry') ?? '')
      res.end('<html><head><title>Posted</title></head><body><main><h1>Posted</h1></main></body></html>')
    })
  } else
    res.end(
      '<html><head><title>Work log</title></head><body><main><h1>Work log</h1>' +
        '<form action="/post" method="post"><input name="entry" aria-label="Entry"/><button type="submit">Submit</button></form>' +
        '</main></body></html>',
    )
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('no site')
const siteUrl = `http://127.0.0.1:${address.port}/`

// The vault: what was done today, and how the log is filed (taught once).
// The vault is written in the person's own language, as a real one is.
await createNote(paths, { body: '# 오늘 한 일: 리플레이어 배포\n\n루틴 재생기와 제출 승인 게이트를 끝냈다. e2e 27개 전부 통과.' })
await createNote(paths, { body: '# 오늘 한 일: 메모리 게이트 수정\n\n로드 계획이 캐시와 버퍼까지 세도록 고쳤다. 더 이상 먹통 없음.' })
const routine = await addRoutine(paths, {
  name: 'Post the daily work log',
  steps: [
    { kind: 'open', url: `${siteUrl}log` },
    { kind: 'type', target: { text: 'Entry' }, text: '{{entry}}' },
    { kind: 'click', target: { text: 'Submit' } },
  ],
})
console.log(`comet-work-probe: seeded 2 notes + procedure ${routine.id} (blank: entry)`)

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

// Wait for the local engine to be detected before asking anything of it.
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'local')) break
  await new Promise((r) => setTimeout(r, 2_000))
}
console.log('comet-work-probe: local engine detected')

const trace: string[] = []
await page.exposeFunction('__probe', (line: string) => {
  trace.push(line)
  console.log(`  ${line}`)
})
await page.evaluate(() => {
  window.engram.onEvent((event) => {
    const w = window as unknown as { __probe(line: string): void }
    if (event.type === 'comet:step') w.__probe(`step  ${event.line}`)
    if (event.type === 'routine:step') w.__probe(`hands ${event.label}`)
    if (event.type === 'routine:submit')
      w.__probe(`GATE  about to post: ${event.filled.map((f) => `${f.label}="${f.text}"`).join(', ')}`)
    if (event.type === 'chat:done') w.__probe(`done  ${event.text.slice(0, 500).replace(/\n/g, ' / ')}`)
    if (event.type === 'chat:error') w.__probe(`error ${event.message}`)
  })
  // The person approves the submit the moment it is shown — the probe's
  // stand-in for reading the gate and pressing "Post it".
  window.engram.onEvent((event) => {
    if (event.type === 'routine:submit') setTimeout(() => void window.engram.routineSubmitDone('approve'), 500)
  })
})

const bot = (await page.evaluate(() =>
  window.engram.botCreate({ name: 'Office helper', purpose: 'Gets the daily chores done: the work log, the portal rounds.' }),
)) as { id: string }

const ask = '오늘 업무일지 올려줘. 오늘 한 일을 볼트에서 찾아서 항목에 채워서.'
console.log(`comet-work-probe: asking — "${ask}" (first model load takes a while)`)
const t0 = Date.now()
await page.evaluate(
  ({ botId, message }) =>
    window.engram.chatSend({ engineId: '', message, history: [], channel: `bot-${botId}`, botId }),
  { botId: bot.id, message: ask },
)

// Give the loop room: several 2B calls plus a Chrome replay.
for (let i = 0; i < 150; i++) {
  if (trace.some((line) => line.startsWith('done') || line.startsWith('error'))) break
  await new Promise((r) => setTimeout(r, 2_000))
}
console.log(`comet-work-probe: finished in ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`comet-work-probe: POSTED = ${JSON.stringify(posted)}`)
const cards = await listCards(paths)
console.log(`comet-work-probe: cards = ${cards.length}${cards[0] ? ` (first: ${cards[0].rationale})` : ''}`)
const verdictLines = [
  trace.some((l) => l.startsWith('step')) ? 'loop used tools' : 'loop used NO tools (fell back to plain answer)',
  trace.some((l) => l.startsWith('GATE')) ? 'submit gate was shown' : 'submit gate never fired',
  posted.length > 0 ? `site received ${posted.length} post(s)` : 'nothing was posted',
]
console.log(`comet-work-probe: VERDICT — ${verdictLines.join(' · ')}`)

await app.close()
await new Promise<void>((resolve) => server.close(() => resolve()))
console.log('comet-work-probe: DONE')
