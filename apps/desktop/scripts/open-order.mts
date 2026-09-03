// What the comets tab shows in its first second: the order the states
// appear in, sampled every few frames. "No comets yet" before the list has
// been read is a claim the app cannot make.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/open-order-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/open-order-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await createBot(paths, { name: 'reader', purpose: 'reads pages' })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
const seen: string[] = []
for (let i = 0; i < 1600; i++) {
  // A string, not a function: the runner's helpers do not exist in the page.
  const state = (await page
    .evaluate(`(() => {
      const has = (id) => document.querySelector('[data-testid="' + id + '"]') !== null
      if (has('bots-loading')) return 'loading'
      if (document.querySelector('.bots-empty-title')) return 'NO-COMETS'
      if (has('bots-thread')) return document.querySelector('.bots-hint') ? 'thread+hint' : 'thread'
      if (has('shell')) return 'shell'
      return 'boot'
    })()`)
    .catch(() => 'boot')) as string
  if (seen[seen.length - 1] !== state) seen.push(state)
  if (state.startsWith('thread')) break
  await page.waitForTimeout(25)
}
console.log('first second, in order:', seen.join(' → '))
await app.close()
