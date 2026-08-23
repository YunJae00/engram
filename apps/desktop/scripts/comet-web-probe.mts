// The session the person actually had, reproduced against the REAL model: a
// question the vault cannot answer, then a follow-up that only makes sense in
// context. Both went wrong in the shipped build — the web tools were never on
// the menu, and the loop never saw the conversation.
//
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/comet-web-probe.mts"
import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import os from 'node:os'

const VAULT = fileURLToPath(new URL('../../../tmp/comet-web-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/comet-web-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(join(USERDATA, 'models'), { recursive: true })
console.log(`comet-web-probe: free memory ${(os.freemem() / 1e9).toFixed(1)}GB`)

const mk = spawnSync(
  'cmd.exe',
  ['/c', 'mklink', '/J', join(USERDATA, 'models', 'gguf'), join(process.env['APPDATA']!, 'desktop', 'models', 'gguf')],
  { windowsHide: true },
)
if (mk.status !== 0) {
  console.error('junction failed — cannot reach the real model')
  process.exit(1)
}
await writeFile(join(USERDATA, 'local-llm.json'), JSON.stringify({ activeModelId: 'gemma4-e2b' }))
// The person has already pasted a results address once, as they would in
// Settings — the app itself still knows no engines.
await writeFile(
  join(USERDATA, 'settings.json'),
  JSON.stringify({ defaultEngine: 'local', autoStart: false, teamSync: 'auto', searchTemplate: process.env['PROBE_SEARCH'] ?? '' }),
)

// A vault about this person's own product — the notes that were wrongly
// served as an answer about the AI industry.
for (const body of [
  '# Strata 기능 변경\n\n보내기 버튼을 하나로 통합하고 웹 스위치를 옆에 두기로 결정했다.',
  '# 오늘 한 일\n\n리플레이어와 제출 승인 게이트를 끝냈다.',
])
  await createNote(paths, { body })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'local')) break
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
    if (event.type === 'comet:step') w.__probe(`step   ${event.line}`)
    if (event.type === 'chat:done') w.__probe(`ANSWER ${event.text.slice(0, 300).replace(/\n/g, ' / ')}`)
    if (event.type === 'chat:error') w.__probe(`ERROR  ${event.message.slice(0, 160)}`)
  })
})

const bot = (await page.evaluate(() =>
  window.engram.botCreate({ name: 'ai researcher', purpose: 'ai 동향 파악하는 리서처' }),
)) as { id: string }

const history: { role: 'user' | 'assistant'; text: string }[] = []
const asks = ['네이버에서 ai 관련 리서치좀 부탁해', '다 한거야?']
for (const ask of asks) {
  trace = []
  console.log(`\ncomet-web-probe: "${ask}"`)
  const t0 = Date.now()
  await page.evaluate(
    ({ botId, message, turns }) =>
      window.engram.chatSend({ engineId: '', message, history: turns, channel: `bot-${botId}`, botId }),
    { botId: bot.id, message: ask, turns: history },
  )
  for (let i = 0; i < 180; i++) {
    if (trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR'))) break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  const answer = trace.find((l) => l.startsWith('ANSWER'))?.slice(7) ?? '(none)'
  history.push({ role: 'user', text: ask }, { role: 'assistant', text: answer })
  const usedWeb = trace.some((l) => /search_web|open_page|read_open_page/.test(l))
  console.log(
    `comet-web-probe: ${Math.round((Date.now() - t0) / 1000)}s · ${usedWeb ? 'WENT TO THE WEB' : 'vault only'}`,
  )
}

await app.close()
console.log('comet-web-probe: DONE')
