// The first two seconds of the app, filmed: what colour is on screen when,
// and when the shell arrives. The flash the user sees is in here.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/bootfilm-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/bootfilm-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
const started = Date.now()
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
const frames: string[] = []
for (let i = 0; i < 60; i++) {
  const at = Date.now() - started
  const state = (await page
    .evaluate(`(() => {
      const boot = document.getElementById('boot')
      const shell = document.querySelector('[data-testid="shell"]') ? 'shell' : ''
      const fading = boot && boot.style.opacity === '0' ? 'boot-fading' : boot ? 'boot' : ''
      return [shell, fading].filter(Boolean).join('+') || 'blank'
    })()`)
    .catch(() => 'no-dom')) as string
  if (frames[frames.length - 1]?.split(' ')[1] !== state) frames.push(`${String(at).padStart(5)}ms ${state}`)
  if (state === 'shell' && i > 3) break
  await page.waitForTimeout(60)
}
for (const f of frames) console.log(f)
await app.close()
console.log('boot-film: DONE')
