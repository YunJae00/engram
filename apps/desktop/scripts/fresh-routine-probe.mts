// Two things the person doubts: that a conversation can be started over
// mid-turn, and that a kept routine pressed in the rail actually runs.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/fresh-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/fresh-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const bot = await createBot(paths, { name: 'runner', purpose: 'runs errands' })
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
await page.getByTestId(`bot-${bot.id}`).click()

// ── 1. Fresh start, mid-turn ─────────────────────────────────────────────
const box = page.locator('.bots-write textarea')
await box.click()
await box.fill('open https://en.wikipedia.org/wiki/Seoul and read me the whole History section, slowly and in detail')
await box.press('Enter')
await page.waitForTimeout(9_000)
await page.getByTestId('bots-fresh').click()
await page.waitForTimeout(1_500)
const bubbles = await page.locator('.bubble-msg').count()
const enabled = await box.isEnabled()
console.log(`after New chat mid-turn: bubbles ${bubbles}, composer ${enabled ? 'open' : 'LOCKED'}`)
const chats = (await readdir(join(VAULT, 'workspace', '.engram', 'bot-chats')).catch(() => [])) as string[]
console.log(`transcripts on disk: ${chats.join(', ') || '(none)'}`)
// The next turn starts clean and answers.
let done = ''
await page.exposeFunction('__done', (text: string) => (done = text))
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'chat:done') window.__done(e.text || ''); if (e.type === 'chat:error') window.__done('ERROR ' + e.message) })`)
await box.click()
await box.fill('say only the word "fresh" and nothing else')
await box.press('Enter')
for (let i = 0; i < 60 && !done; i++) await page.waitForTimeout(2_000)
console.log(`the turn after: ${done.replace(/\s+/g, ' ').slice(0, 60) || '(no answer)'}`)

// ── 2. A routine pressed in the rail ─────────────────────────────────────
await page.evaluate((id) => window.engram.botTaskAdd(id, { name: 'Seoul line', goal: 'Open https://en.wikipedia.org/wiki/Seoul and give me its population, one line' }), bot.id)
await page.waitForTimeout(800)
const routineBtn = page.locator('[data-testid^="rail-routine-"]').first()
const visible = await routineBtn.isVisible().catch(() => false)
console.log(`routine listed in the rail: ${visible ? 'yes' : 'NO'}`)
done = ''
const logged: string[] = []
await page.exposeFunction('__err', (line: string) => logged.push(line))
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'errand:phase') window.__err(e.phase); if (e.type === 'errand:logged') window.__err('logged') })`)
await routineBtn.click()
for (let i = 0; i < 90 && !logged.includes('logged'); i++) await page.waitForTimeout(2_000)
console.log(`routine run phases: ${logged.join(' → ') || '(nothing happened)'}`)
const thread = await page.locator('.bubble-msg').last().innerText().catch(() => '')
console.log(`thread tail: ${thread.replace(/\s+/g, ' ').slice(0, 90)}`)
await app.close()
console.log('fresh-routine-probe: DONE')
