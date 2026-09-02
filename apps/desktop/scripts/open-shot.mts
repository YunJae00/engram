// What the window shows in its first second: the frames a person actually
// sees while the app opens. Opening and closing is part of the product, so
// this is photographed like any other screen.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/open-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/open-userdata/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/open-shot/', import.meta.url))
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
if (process.env['OPEN_FRESH'] !== '0') {
  await rm(VAULT, { recursive: true, force: true })
  await rm(USERDATA, { recursive: true, force: true })
  await initVault(VAULT, { git: false })
  await mkdir(USERDATA, { recursive: true })
  await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
}

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
// A burst through the first second, then one settled frame.
for (const at of [0, 120, 250, 400, 700, 1100]) {
  await page.waitForTimeout(at === 0 ? 0 : at - (at === 120 ? 0 : 0))
  await page.screenshot({ path: join(OUT, `t${String(at).padStart(4, '0')}.png`) }).catch(() => {})
}
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'settled.png') })
await app.close()
console.log(`open-shot → ${OUT}`)
