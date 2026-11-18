import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'vaultfail-'))

await writeFile(join(root, 'workspace'), 'not a directory')

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

const failed = page.getByTestId('vault-failed')
try {
  await failed.waitFor({ state: 'visible', timeout: 30_000 })
} catch {
  const opening = await page.getByTestId('vault-opening').isVisible().catch(() => false)
  console.log(`no failure screen. still showing the opening state: ${opening}`)
  await app.close()
  await rm(root, { recursive: true, force: true })
  process.exit(1)
}

console.log('failure screen:\n')
console.log((await failed.innerText()).split('\n').map((l) => `  ${l}`).join('\n'))

for (const label of ['Show the folder', 'Try again']) {
  const btn = page.getByRole('button', { name: label })
  console.log(`\n  [${label}] ${(await btn.isEnabled()) ? 'enabled' : 'DISABLED'}`)
}

const fits = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="vault-failed"]')!.getBoundingClientRect()
  return {
    inside: el.right <= window.innerWidth + 1 && el.left >= -1,
    scrolls: document.documentElement.scrollWidth > window.innerWidth,
  }
})
console.log(`\n  inside the window: ${fits.inside}   page scrolls sideways: ${fits.scrolls}`)

await app.close()
await rm(root, { recursive: true, force: true })
