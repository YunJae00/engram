// Screenshots of the surfaces the polish touched, for a human look.
import { launchApp } from './launch-app.mts'
import { createNote, initVault } from 'core'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const RUN = Date.now().toString(36)
const VAULT = fileURLToPath(new URL(`../../../tmp/shots-${RUN}-vault/`, import.meta.url))
const USERDATA = fileURLToPath(new URL(`../../../tmp/shots-${RUN}-userdata/`, import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/ui-review/', import.meta.url))
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await mkdir(OUT, { recursive: true })
for (const body of ['# Deploy decision\n\nThursday afternoons, helm charts.', '# Team contacts\n\nDeploys: Jiwoo (x4192).'])
  await createNote(paths, { body })

const app = await launchApp({ ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' })
const page = app.page
await page.setViewportSize({ width: 1280, height: 840 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 120_000 })
const shot = (name: string) => page.screenshot({ path: `${OUT}${name}.png` })

await page.evaluate(() => window.engram.botCreate({ name: 'Research scout', purpose: 'runs web errands' }))
await page.evaluate(() => window.engram.botCreate({ name: 'ai', purpose: 'ai research' }))
await page.getByTestId('activity-bots').click()
await page.waitForTimeout(600)
await shot('comets-open')
await page.locator('.bots-write textarea').fill('첫 줄\n둘째 줄\n셋째 줄')
await page.waitForTimeout(200)
await shot('comets-composer-3-lines')
await page.locator('.bots-write textarea').fill('')
await page.getByTestId('comets-rail-close').click()
await page.waitForTimeout(500)
await shot('comets-folded')
await page.getByTestId('comets-rail-open').click()
await page.getByTestId('activity-sky').click()
await page.waitForTimeout(800)
await shot('cosmos-open')
await page.getByTitle('Hide').click()
await page.waitForTimeout(500)
await shot('cosmos-folded')
await page.getByTestId('cosmos-chat-open').click()
await page.getByTestId('activity-brain').click()
await page.waitForTimeout(600)
await shot('brain')
await page.keyboard.press('Control+K')
await page.waitForTimeout(300)
const palette = page.locator('[cmdk-root]')
if (await palette.count()) {
  await page.keyboard.type('routines')
  await page.waitForTimeout(300)
  await shot('palette')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  await shot('routines-sheet')
}
await app.close()
console.log('shots in', OUT)
process.exit(0)
