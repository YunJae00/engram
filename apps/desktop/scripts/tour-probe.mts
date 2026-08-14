// First-run tour probe: fresh userdata + ENGRAM_TOUR=1 → the coach marks
// must appear after the vault opens, walk all steps, and never come back.
import { _electron as electron } from '@playwright/test'
import { createNote, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/tour-probe-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/tour-probe/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await createNote(paths, { body: '# 첫 기억\n\n투어 프로브용 노트.' })
await mkdir(OUT, { recursive: true })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: VAULT,
    ENGRAM_USERDATA: join(VAULT, '..', 'tour-probe-userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_TOUR: '1',
  },
})
const page = await app.firstWindow()
await page.getByTestId('tour-overlay').waitFor({ state: 'visible', timeout: 30_000 })
await page.screenshot({ path: join(OUT, '01-welcome.png') })
for (let i = 1; i <= 5; i++) {
  await page.getByTestId('tour-next').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `0${i + 1}-step.png`) })
}
await page.getByTestId('tour-next').click() // last step: "Start using Engram"
await page.waitForTimeout(300)
const gone = (await page.getByTestId('tour-overlay').count()) === 0
console.log('tour closed:', gone)
// The flag must persist: reload the window state check via localStorage.
const done = await page.evaluate(() => localStorage.getItem('engram.tour.done'))
console.log('done flag:', done)
await app.close()
console.log('shots →', OUT)
