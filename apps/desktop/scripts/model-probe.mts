// Whether the model a person picks is the model that answers. Asked twice on
// one comet, with the pick changed in between: the runtime's own answer to
// "which model are you" is the evidence.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/model-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/model-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const bot = await createBot(paths, { name: 'asker', purpose: 'answers plainly' })

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

let answer = ''
await page.exposeFunction('__answered', (text: string) => {
  answer = text
})
await page.evaluate(
  `window.engram.onEvent((e) => { if (e.type === 'chat:done') window.__answered(e.text || ''); if (e.type === 'chat:error') window.__answered('ERROR ' + e.message) })`,
)
await page.getByTestId(`bot-${bot.id}`).click()

async function ask(model: string): Promise<string> {
  await page.evaluate(async (m) => {
    const held = await window.engram.settingsGet()
    await window.engram.settingsSet({ ...held, claudeModel: m })
  }, model)
  answer = ''
  const box = page.locator('.bots-write textarea')
  await box.click()
  await box.fill('Which model are you? Answer with the model name only, nothing else.')
  await box.press('Enter')
  for (let i = 0; i < 90 && !answer; i++) await page.waitForTimeout(2_000)
  return answer.replace(/\s+/g, ' ').slice(0, 120)
}

for (const model of ['haiku', 'opus']) {
  console.log(`picked "${model}" → ${await ask(model)}`)
}
await app.close()
console.log('model-probe: DONE')
