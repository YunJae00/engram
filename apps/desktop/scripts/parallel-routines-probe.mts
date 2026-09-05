// Two comets, each with a recorded procedure, pressed in the rail moments
// apart: both must replay side by side on their own tabs and answer in
// their own threads.
import { _electron as electron } from '@playwright/test'
import { addRoutine, createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/parroutine-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/parroutine-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const a = await createBot(paths, { name: 'alpha', purpose: 'reads pages' })
const b = await createBot(paths, { name: 'beta', purpose: 'reads pages' })
const ra = await addRoutine(paths, { name: 'Seoul talk title', steps: [{ kind: 'open', url: 'https://en.wikipedia.org/wiki/Seoul' }, { kind: 'click', target: { text: 'Talk' } }, { kind: 'read' }] })
const rb = await addRoutine(paths, { name: 'Busan history title', steps: [{ kind: 'open', url: 'https://en.wikipedia.org/wiki/Busan' }, { kind: 'click', target: { text: 'View history' } }, { kind: 'read' }] })

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
await page.evaluate(
  ({ aId, raId, bId, rbId }) =>
    Promise.all([
      window.engram.botTaskAdd(aId, { name: 'Seoul talk title', goal: 'Run the saved "Seoul talk title" procedure and tell me the title of the page it ends on', routineId: raId }),
      window.engram.botTaskAdd(bId, { name: 'Busan history title', goal: 'Run the saved "Busan history title" procedure and tell me the title of the page it ends on', routineId: rbId }),
    ]),
  { aId: a.id, raId: ra.id, bId: b.id, rbId: rb.id },
)
await page.waitForTimeout(800)
const done = new Map<string, string>()
await page.exposeFunction('__done', (channel: string, text: string) => done.set(channel, text))
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'chat:done' || e.type === 'chat:error') window.__done(e.channel, (e.text || e.message || '').slice(0, 90)) })`)
const listed = (await page.evaluate(() => window.engram.botsList())) as { name: string; tasks?: { name: string; routineId?: string }[] }[]
console.log('tasks on disk:', JSON.stringify(listed.map((x) => ({ n: x.name, t: (x.tasks ?? []).map((t) => t.name + (t.routineId ? '(rt)' : '')) }))))
console.log('rail testids:', await page.evaluate(`Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).filter((t) => t.includes('routine') || t.includes('rail')).join(', ')`))
const started = Date.now()
const buttons = page.locator('[data-testid^="sidebar-routine-run-"]')
await buttons.nth(0).click()
await page.waitForTimeout(1_200)
await buttons.nth(1).click()
for (let i = 0; i < 150 && done.size < 2; i++) await page.waitForTimeout(2_000)
console.log(`both routine runs answered: ${done.size === 2 ? 'yes' : 'NO (' + done.size + ')'} in ${Math.round((Date.now() - started) / 1000)}s`)
for (const [channel, text] of done) console.log(`  ${channel}: ${text.replace(/\s+/g, ' ')}`)
await app.close()
console.log('parallel-routines-probe: DONE')
