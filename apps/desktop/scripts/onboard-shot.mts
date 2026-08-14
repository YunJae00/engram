// Onboarding full walk: capture every step for the spacing audit.
import { _electron as electron } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const USERDATA = fileURLToPath(new URL('../../../tmp/onboard-userdata/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/onboard-shot/', import.meta.url))

await rm(USERDATA, { recursive: true, force: true })
await mkdir(USERDATA, { recursive: true })
await mkdir(OUT, { recursive: true })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('onboarding').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(OUT, 'step1.png') })
await page.getByTestId('onboard-next').click()
await page.getByTestId('onboard-step-2').waitFor({ state: 'visible' })
await page.waitForTimeout(1200)
await page.screenshot({ path: join(OUT, 'step2.png') })
await page.getByTestId('onboard-skip-ai').click()
await page.getByTestId('onboard-step-3').waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, 'step3.png') })
await page.getByTestId('onboard-skip-import').click()
await page.getByTestId('onboard-step-4').waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, 'step4.png') })
await page.getByTestId('onboard-skip-team').click()
await page.getByTestId('onboard-step-5').waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, 'step5.png') })
await app.close()
console.log('shots →', OUT)
