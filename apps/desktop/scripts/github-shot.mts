// GitHub backup dialog snapshot — opens the workspace switcher, clicks the
// "Back up to GitHub" row, and captures the two-step dialog.
import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/github-shot/', import.meta.url))

await mkdir(OUT, { recursive: true })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: ROOT,
    ENGRAM_USERDATA: join(ROOT, '.userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_ENGINE: 'none',
  },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(1000)

// Open the "Personal ▾" switcher and take the "Back up to GitHub" row.
await page.getByTestId('workspace-switcher').click()
await page.getByTestId('workspace-github-backup').waitFor({ state: 'visible' })
await page.getByTestId('workspace-github-backup').click()

await page.getByTestId('github-connect').waitFor({ state: 'visible' })
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, 'github-connect.png') })

// A quick second frame with a URL typed in, so the connect button is live.
await page.getByTestId('github-url').fill('https://github.com/me/engram-personal')
await page.waitForTimeout(200)
await page.screenshot({ path: join(OUT, 'github-connect-filled.png') })

await app.close()
console.log('shot →', OUT)
