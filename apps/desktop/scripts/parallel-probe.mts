// Two comets at once, each on the web: do both answer, on their own tabs,
// and does the pane show the tab of whichever comet is being looked at?
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/parallel-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/parallel-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const a = await createBot(paths, { name: 'alpha', purpose: 'reads pages' })
const b = await createBot(paths, { name: 'beta', purpose: 'reads pages' })

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
const done = new Map<string, string>()
await page.exposeFunction('__done', (channel: string, text: string) => done.set(channel, text))
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'chat:done' || e.type === 'chat:error') window.__done(e.channel, (e.text || e.message || '').slice(0, 80)) })`)

const ask = async (botId: string, text: string) => {
  await page.getByTestId(`bot-${botId}`).click()
  const box = page.locator('.bots-write textarea')
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}
const started = Date.now()
await ask(a.id, 'open https://en.wikipedia.org/wiki/Seoul and tell me its population in one line')
await page.waitForTimeout(1_500)
// The second comet must accept the ask while the first is still working.
await ask(b.id, 'open https://en.wikipedia.org/wiki/Busan and tell me its population in one line')
const sendable = await page.locator('.bots-write textarea').isEnabled()
console.log(`second comet's composer while the first works: ${sendable ? 'open' : 'LOCKED'}`)

for (let i = 0; i < 120 && done.size < 2; i++) await page.waitForTimeout(2_000)
console.log(`both answered: ${done.size === 2 ? 'yes' : 'NO'} in ${Math.round((Date.now() - started) / 1000)}s`)
for (const [channel, text] of done) console.log(`  ${channel}: ${text.replace(/\s+/g, ' ')}`)

// The pane follows the comet being looked at.
await page.getByTestId(`bot-${a.id}`).click()
await page.waitForTimeout(800)
const urlA = await page.getByTestId('live-address').inputValue().catch(() => '(no pane)')
await page.getByTestId(`bot-${b.id}`).click()
await page.waitForTimeout(800)
const urlB = await page.getByTestId('live-address').inputValue().catch(() => '(no pane)')
console.log(`pane on alpha: ${urlA}\npane on beta:  ${urlB}`)
console.log(`own tabs: ${urlA !== urlB && urlA.includes('Seoul') && urlB.includes('Busan') ? 'yes' : 'NO'}`)
await app.close()
console.log('parallel-probe: DONE')
