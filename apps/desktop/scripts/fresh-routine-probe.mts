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
  const engines = (await page.evaluate(() => window.engram.engines()).catch(() => [])) as { id: string }[]
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

// ── 2. A web turn, kept as a routine: the path is recorded, and pressing
//      it in the rail runs it as an ordinary turn in this chat ────────────
done = ''
await box.click()
await box.fill('open https://en.wikipedia.org/wiki/Seoul, press the "Talk" tab, and tell me the page title')
await box.press('Enter')
for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(2_000)
console.log(`the shown turn: ${done ? 'answered' : 'NO ANSWER'}`)
await page.evaluate((id) => window.engram.botTaskAdd(id, { name: 'Seoul talk check', goal: 'Open the Seoul wikipedia article, press the Talk tab, tell me the page title' }), bot.id)
await page.waitForTimeout(800)
const kept = (await page.evaluate(() => window.engram.botsList())) as { tasks?: { routineId?: string }[] }[]
const routineId = kept.flatMap((b) => b.tasks ?? []).find((t) => t.routineId)?.routineId
console.log(`recorded a procedure: ${routineId ? routineId : 'NO'}`)
const routines = (await page.evaluate(() => window.engram.routinesList())) as { id: string; steps: { kind: string }[] }[]
const steps = routines.find((r) => r.id === routineId)?.steps ?? []
console.log(`its steps: ${steps.map((s) => s.kind).join(' → ') || '(none)'}`)
const routineBtn = page.locator('[data-testid^="rail-routine-"]').first()
console.log(`routine listed in the rail: ${(await routineBtn.isVisible().catch(() => false)) ? 'yes' : 'NO'}`)
done = ''
await routineBtn.click()
for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(2_000)
console.log(`run from the rail, in the chat: ${done ? done.replace(/\s+/g, ' ').slice(0, 80) : '(no answer)'}`)
await app.close()
console.log('fresh-routine-probe: DONE')
