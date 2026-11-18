import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'startup-'))
await initVault(root, { git: false })

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

await page.getByTestId('vault-opening').waitFor({ state: 'detached', timeout: 60_000 })
const usable = Date.now() - t0
console.log('usable (Remember) ', usable + 'ms')

const windowToShell = usable - firstWindow
console.log('window -> usable  ', windowToShell + 'ms   <-- the A/B number')

await app.close()
console.log('-'.repeat(46))
console.log(`RESULT window->usable ${windowToShell}ms (total ${usable}ms)`)
