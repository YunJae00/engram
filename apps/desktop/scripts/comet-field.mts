// The field set: everyday chores from many kinds of work, put to a comet on
// a cloud brain against the real web. Nothing here is judged by a regex -
// every answer is recorded beside its steps and its time, for a reader to
// judge afterwards. FIELD_TASKS points at the JSON list; FIELD_OFFSET and
// FIELD_LIMIT pick a slice; FIELD_BRAIN picks the brain (claude by default).
import { type Page } from '@playwright/test'
import { launchApp } from './launch-app.mts'
import { createNote, initVault } from 'core'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

interface Task {
  ask: string
  kind: string
  lang: string
  domain: string
  good: string
}

interface Record_ {
  index: number
  ask: string
  kind: string
  lang: string
  domain: string
  good: string
  answer: string
  tools: string[]
  steps: string[]
  seconds: number
  offer: string | null
  asked: boolean
  error: string | null
}

const RUN = Date.now().toString(36)
const VAULT = fileURLToPath(new URL(`../../../tmp/field-${RUN}-vault/`, import.meta.url))
const USERDATA = fileURLToPath(new URL(`../../../tmp/field-${RUN}-userdata/`, import.meta.url))
const OUT = fileURLToPath(new URL(`../../../tmp/field-${RUN}.json`, import.meta.url))
const BRAIN = process.env['FIELD_BRAIN'] ?? 'claude'
// A search page that answers an automated window with results rather than
// a human check (measured: two of the big ones do not).
const SEARCH = process.env['FIELD_SEARCH'] ?? 'https://html.duckduckgo.com/html/?q={q}'
const BATCH = 8
const TURN_LIMIT_S = 300

const tasksFile = process.env['FIELD_TASKS']
if (!tasksFile) {
  console.error('FIELD_TASKS must point at the task list')
  process.exit(1)
}
const all = JSON.parse(await readFile(tasksFile, 'utf8')) as Task[]
const offset = Number(process.env['FIELD_OFFSET'] ?? 0)
const limit = Number(process.env['FIELD_LIMIT'] ?? all.length)
const tasks = all.slice(offset, offset + limit)
console.log(`comet-field: ${tasks.length} task(s) from #${offset} on ${BRAIN}`)

const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
// The whole model shelf: the embedder is a big download, and a fresh profile
// every run would fetch it every run.
spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(USERDATA, 'models'), join(process.env['APPDATA']!, 'desktop', 'models')], { windowsHide: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: BRAIN, autoStart: false, teamSync: 'auto', searchTemplate: SEARCH }))

// A small, lived-in notebook so the memory tools have something to find and
// the rest of the asks meet a comet that knows its person a little.
for (const body of [
  '# Vendor onboarding checklist\n\nSteps: W-9 on file, security questionnaire, insurance certificate, NDA, reference call. Last quarter we dropped the reference call and the insurance certificate for vendors under $5k.',
  '# Deploy decision\n\nDeploys move to Thursday afternoon; helm charts everywhere. Friday deploys are banned.',
  '# Team contacts\n\nDeploys: Jiwoo Lee (ext 4192). Security review: Hyunsoo Park (ext 4207). Facilities: Mina Choi.',
  '# Q3 offsite\n\nOffsite is Sept 18-19 in Busan. Budget 4.2M KRW. Venue deposit paid on Aug 12.',
  '# 회의 메모\n\n다음 스프린트는 검색 품질에 집중하고 알림 기능은 뒤로 미룬다. 릴리즈 노트 초안은 목요일까지.',
  '# Reading list\n\nAttention Is All You Need (2017); The Mythical Man-Month; Designing Data-Intensive Applications (chapters 5-7 pending).',
  '# Home admin\n\nCar insurance renews Wed. Internet move-in request needed a week before Sept 20 move. Coffee beans before guests Saturday.',
])
  await createNote(paths, { body })

interface Running {
  page: Page
  botId: string
  close: () => Promise<void>
  trace: string[]
}

async function openApp(): Promise<Running> {
  const app = await launchApp({
    ENGRAM_SYSTEM_FRAME: '1',
    ENGRAM_VAULT: VAULT,
    ENGRAM_USERDATA: USERDATA,
    ENGRAM_NO_GIT: '1',
    ENGRAM_NO_AUTOTIDY: '1',
    ENGRAM_INDEX_NOW: '1',
    ENGRAM_SEMANTIC: '1',
    ENGRAM_STEP_DETAIL: '1',
    ENGRAM_AGENT_OFFSCREEN: '1',
  })
  const page: Page = app.page
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 120_000 })
  for (let i = 0; i < 40; i++) {
    const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
    if (engines.some((e) => e.id === BRAIN)) break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  for (let i = 0; i < 60; i++) {
    const semantic = (await page.evaluate(() => window.engram.semanticStatus())) as { status: string }
    if (semantic.status === 'ready' || semantic.status === 'error') break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  const trace: string[] = []
  // Each line carries the second it landed on, so a slow turn shows which
  // step took the time.
  await page.exposeFunction('__probe', (line: string) => {
    trace.push(line.startsWith('step ') ? `${line} @${Math.round((Date.now() - turnStart) / 1000)}s` : line)
  })
  await page.evaluate(() => {
    const w = window as unknown as { __probe(line: string): void }
    window.engram.onEvent((event) => {
      if (event.type === 'comet:step') w.__probe(`step ${event.line}`)
      if (event.type === 'chat:done') w.__probe(`ANSWER ${JSON.stringify({ text: event.text, offer: event.offer ?? null })}`)
      if (event.type === 'chat:error') w.__probe(`ERROR ${event.message}`)
    })
  })
  return { page, botId: '', close: app.close, trace }
}

let turnStart = Date.now()
const records: Record_[] = []
let running: Running | null = null
let inBatch = 0

for (const [i, task] of tasks.entries()) {
  if (!running || inBatch >= BATCH) {
    if (running) await running.close().catch(() => undefined)
    running = await openApp()
    inBatch = 0
  }
  inBatch++
  // Every ask is its own comet: nothing from the last ask sits in the
  // brain's context, and each turn is the cold first turn a person meets.
  const { page, trace } = running
  const botId = ((await page.evaluate((n) => window.engram.botCreate({ name: 'Field comet ' + n, purpose: '' }), i)) as { id: string }).id
  trace.length = 0
  const started = Date.now()
  turnStart = started
  await page.evaluate(
    ({ botId, message }) => window.engram.chatSend({ engineId: '', message, history: [], channel: `bot-${botId}`, botId }),
    { botId, message: task.ask },
  )
  for (let waited = 0; waited < TURN_LIMIT_S; waited += 2) {
    if (trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR'))) break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  if (!trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR')))
    await page.evaluate((botId) => window.engram.chatAbort(`bot-${botId}`), botId).catch(() => undefined)
  const answerLine = trace.find((l) => l.startsWith('ANSWER'))
  const parsed = answerLine ? (JSON.parse(answerLine.slice(7)) as { text: string; offer: { kind: string } | null }) : null
  const error = trace.find((l) => l.startsWith('ERROR'))?.slice(6) ?? (answerLine ? null : 'no answer within the time limit')
  const record: Record_ = {
    index: offset + i,
    ask: task.ask,
    kind: task.kind,
    lang: task.lang,
    domain: task.domain,
    good: task.good,
    answer: parsed?.text ?? '',
    tools: trace.filter((l) => l.startsWith('step ') && !l.startsWith('step   <-')).map((l) => l.slice(5).split(':')[0]!.trim()),
    steps: trace.filter((l) => l.startsWith('step ')),
    seconds: Math.round((Date.now() - started) / 1000),
    offer: parsed?.offer?.kind ?? null,
    asked: parsed?.offer?.kind === 'asked' || /\?\s*$/.test((parsed?.text ?? '').trim()),
    error,
  }
  records.push(record)
  await writeFile(OUT, JSON.stringify(records, null, 1))
  console.log(
    `#${record.index} ${record.seconds}s ${error ? 'ERROR' : record.asked ? 'ASKED' : 'OK'} [${record.tools.join(' → ') || 'no tools'}] ${(error ?? record.answer).replace(/\s+/g, ' ').slice(0, 110)}`,
  )
}
if (running) await running.close().catch(() => undefined)
console.log(`comet-field: ${records.length} recorded -> ${OUT}`)
