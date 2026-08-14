// How long until the shell is usable? Measures the real packaged-code path in
// a real Electron window, because "the app is slow" was answered with guesses
// until someone timed it. Reports first paint and when the engine banner state
// settles, which used to be the same (blocking) moment.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'startup-'))
await initVault(root, { git: false })

// ENGRAM_ENGINE unset = the real detection path (the thing being measured).
const t0 = Date.now()
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1' },
})
const page = await app.firstWindow()
const firstWindow = Date.now() - t0
console.log('first window      ', Date.now() - t0 + 'ms')

await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
console.log('shell visible     ', Date.now() - t0 + 'ms')

// The vault is OPEN — the "opening…" placeholder is gone. This is the marker
// gated on vault:ready, which is what engine detection used to sit in front of.
await page.getByTestId('vault-opening').waitFor({ state: 'detached', timeout: 60_000 })
const usable = Date.now() - t0
console.log('usable (Remember) ', usable + 'ms')

// Electron's own cold start dominates and is noisy, so the number to compare
// A/B is the window→shell leg: that is where openVaultContext (and, before the
// fix, engine detection) is paid for.
const windowToShell = usable - firstWindow
console.log('window -> usable  ', windowToShell + 'ms   <-- the A/B number')

await app.close()
console.log('-'.repeat(46))
console.log(`RESULT window->usable ${windowToShell}ms (total ${usable}ms)`)
