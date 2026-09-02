// Whether a question about the person's own work is answered from their
// notebook rather than from a search engine. Two asks: one the vault holds,
// one it plainly does not.
import { _electron as electron } from '@playwright/test'
import { createBot, createNote, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/notebook-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/notebook-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
for (const body of [
  '# Release cadence decided\n\nWe ship on Tuesdays. Friday releases were dropped after the March rollback.',
  '# Who owns the parser\n\nThe parser is owned by the platform group; escalations go to them first.',
])
  await createNote(paths, { body })
const bot = await createBot(paths, { name: 'colleague', purpose: 'knows my work' })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'claude')) break
  await page.waitForTimeout(2_000)
}

let trace: string[] = []
await page.exposeFunction('__probe', (line: string) => {
  trace.push(line)
})
await page.evaluate(`window.engram.onEvent((e) => {
  if (e.type === 'comet:step') window.__probe('step ' + e.line)
  if (e.type === 'chat:done') window.__probe('ANSWER ' + (e.text || '').slice(0, 160).replace(/\\n/g, ' / '))
  if (e.type === 'chat:error') window.__probe('ERROR ' + e.message)
})`)
await page.getByTestId(`bot-${bot.id}`).click()

const asks = ['우리 릴리즈 언제 하기로 했었지?', '오늘 서울 날씨 어때?']
for (const ask of asks) {
  trace = []
  const box = page.locator('.bots-write textarea')
  await box.click()
  await box.fill(ask)
  await box.press('Enter')
  for (let i = 0; i < 120; i++) {
    if (trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR'))) break
    await page.waitForTimeout(2_000)
  }
  const web = trace.some((l) => /search_web|open_page|read_open_page/.test(l))
  const memory = trace.some((l) => /search_memory|read_note/.test(l))
  console.log(`\n"${ask}"`)
  console.log(`  notebook: ${memory ? 'yes' : 'no'} · web: ${web ? 'yes' : 'no'}`)
  console.log(`  ${trace.find((l) => l.startsWith('ANSWER'))?.slice(0, 150) ?? '(no answer)'}`)
}
await app.close()
console.log('notebook-first: DONE')
