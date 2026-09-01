// Four chores a working person would actually hand over, run against the REAL
// model in one session, with the trace and a verdict per task. This is the
// measurement that decides whether the comet is useful or merely wired up.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/comet-tasks-probe.mts"
import { _electron as electron } from '@playwright/test'
import { addRoutine, createNote, initVault, listCards } from 'core'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import os from 'node:os'

const VAULT = fileURLToPath(new URL('../../../tmp/comet-tasks-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/comet-tasks-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(join(USERDATA, 'models'), { recursive: true })
console.log(`comet-tasks-probe: free memory ${(os.freemem() / 1e9).toFixed(1)}GB`)

const realGguf = join(process.env['APPDATA']!, 'desktop', 'models', 'gguf')
const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(USERDATA, 'models', 'gguf'), realGguf], { windowsHide: true })
if (mk.status !== 0) {
  console.error('junction failed — cannot reach the real model')
  process.exit(1)
}

// The company portal: a notices page worth reading every morning.
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(
    '<html><head><title>공지</title></head><body><main><h1>공지사항</h1>' +
      '<p>1. 9월 2일부터 사내망 VPN 주소가 vpn2.example로 바뀝니다.</p>' +
      '<p>2. 추석 연휴 전 마지막 배포는 9월 12일 오후 3시까지 신청.</p>' +
      '</main></body></html>',
  )
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('no site')
const siteUrl = `http://127.0.0.1:${address.port}/`

// A week of real work, written the way this person writes.
for (const body of [
  '# 배포 방식 결정\n\n쿠버네티스 배포는 helm 차트로 통일하기로 했다. values 정리는 화요일까지.',
  '# 배포 일정 변경\n\n금요일 배포는 위험해서 목요일 오후로 당기기로 팀에서 합의했다.',
  '# 스테이징 값 위치\n\nhelm values 중 스테이징 클러스터 값은 신규 리포에 두기로 결정.',
  '# 오늘 한 일\n\n리플레이어와 제출 승인 게이트를 끝냈다. 메모리 게이트도 고쳐서 먹통 없음.',
  '# 회의 메모\n\n다음 스프린트는 검색 품질에 집중. 알림 기능은 뒤로 미룬다.',
])
  await createNote(paths, { body })

// A read-only morning round: no blanks, nothing to post — the simplest thing
// the comet could actually DO with its hands.
const rounds = await addRoutine(paths, {
  name: '포털 공지 확인',
  steps: [{ kind: 'open', url: siteUrl }, { kind: 'read' }],
})
console.log(`comet-tasks-probe: seeded 5 notes + read-only procedure ${rounds.id}`)

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'claude')) break
  await new Promise((r) => setTimeout(r, 2_000))
}

let trace: string[] = []
await page.exposeFunction('__probe', (line: string) => {
  trace.push(line)
  console.log(`    ${line}`)
})
await page.evaluate(() => {
  window.engram.onEvent((event) => {
    const w = window as unknown as { __probe(line: string): void }
    if (event.type === 'comet:step') w.__probe(`step  ${event.line}`)
    if (event.type === 'routine:step') w.__probe(`hands ${event.label}`)
    if (event.type === 'routine:submit') w.__probe(`GATE  ${event.filled.map((f) => `${f.label}="${f.text}"`).join(', ')}`)
    if (event.type === 'chat:done') {
      if (event.offer) {
        const taken = event.offer
        w.__probe(`OFFER  ${taken.name}`)
        // The person sees the offer and takes it — one press.
        setTimeout(() => void window.engram.routineRun(taken.routineId, false, taken.slots), 400)
      }
      w.__probe(`ANSWER ${event.text.slice(0, 400).replace(/\n/g, ' / ')}`)
    }
    if (event.type === 'chat:error') w.__probe(`ERROR ${event.message.slice(0, 200)}`)
  })
  window.engram.onEvent((event) => {
    if (event.type === 'routine:submit') setTimeout(() => void window.engram.routineSubmitDone('approve'), 500)
  })
})

const bot = (await page.evaluate(() =>
  window.engram.botCreate({ name: '업무 도우미', purpose: '이 사람의 일을 대신 해낸다: 기억 정리, 초안 작성, 포털 확인.' }),
)) as { id: string }

const TASKS = [
  { name: 'recall', ask: '배포 관련해서 우리가 정한 게 뭐였지?' },
  { name: 'draft', ask: '이번 주 주간보고 초안 써줘. 볼트에 있는 내용으로.' },
  { name: 'keep', ask: '다음 스프린트 방향을 노트로 정리해서 저장해줘.' },
  { name: 'hands', ask: '포털 공지 확인해서 중요한 거 알려줘.' },
]

const results: string[] = []
for (const task of TASKS) {
  trace = []
  const before = (await listCards(paths)).length
  console.log(`\ncomet-tasks-probe: [${task.name}] "${task.ask}"`)
  const t0 = Date.now()
  await page.evaluate(
    ({ botId, message }) => window.engram.chatSend({ engineId: '', message, history: [], channel: `bot-${botId}`, botId }),
    { botId: bot.id, message: task.ask },
  )
  for (let i = 0; i < 120; i++) {
    if (trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR'))) break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  // An offer taken means a replay is now running; wait for its hands.
  if (trace.some((l) => l.startsWith('OFFER')))
    for (let i = 0; i < 45; i++) {
      if (trace.some((l) => l.startsWith('hands'))) break
      await new Promise((r) => setTimeout(r, 2_000))
    }
  await new Promise((r) => setTimeout(r, 8_000))
  const seconds = Math.round((Date.now() - t0) / 1000)
  const after = (await listCards(paths)).length
  const tools = trace.filter((l) => l.startsWith('step')).length
  const hands = trace.some((l) => l.startsWith('hands'))
  const offered = trace.some((l) => l.startsWith('OFFER'))
  const answered = trace.find((l) => l.startsWith('ANSWER'))?.slice(7, 200) ?? '(none)'
  const lied = /했습니다|올렸습니다|저장했습니다/.test(answered) && after === before && !hands
  results.push(
    `${task.name}: ${seconds}s · ${tools} tool call(s)${offered ? ' · OFFERED A RUN' : ''}${hands ? ' · USED HANDS' : ''}${after > before ? ` · ${after - before} card(s)` : ''}${lied ? ' · ⚠ CLAIMED WORK IT DID NOT DO' : ''}`,
  )
}

console.log('\ncomet-tasks-probe: VERDICT')
for (const line of results) console.log(`  ${line}`)
await app.close()
await new Promise<void>((resolve) => server.close(() => resolve()))
console.log('comet-tasks-probe: DONE')
