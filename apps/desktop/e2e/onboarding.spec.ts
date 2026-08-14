import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// M8 acceptance: fresh home → all 5 onboarding screens, including the
// skip-AI path, land in a working shell with the first capture in the inbox.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let vaultRoot: string

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-home-'))
  vaultRoot = join(await mkdtemp(join(REPO_TMP, 'e2e-onboard-')), 'Engram')

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      // NO ENGRAM_VAULT → onboarding must appear
      ENGRAM_VAULT: '',
      ENGRAM_USERDATA: userData,
      ENGRAM_ONBOARD_ROOT: vaultRoot,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  await app?.close()
})

test('walks all five screens (skipping AI) into a working shell', async () => {
  await expect(page.getByTestId('onboarding')).toBeVisible()

  // ① vault location (pre-filled from ENGRAM_ONBOARD_ROOT)
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()

  // ② AI connect — the skip path (everything must still work)
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await page.getByTestId('onboard-skip-ai').click()

  // ③ bulk import — skip
  await expect(page.getByTestId('onboard-step-3')).toBeVisible()
  await page.getByTestId('onboard-skip-import').click()

  // ④ team — later
  await expect(page.getByTestId('onboard-step-4')).toBeVisible()
  await page.getByTestId('onboard-skip-team').click()

  // ⑤ first capture
  await expect(page.getByTestId('onboard-step-5')).toBeVisible()
  await page.getByTestId('first-capture-input').fill('My very first thought: ship the vault')
  await page.getByTestId('onboard-finish').click()

  // lands in the shell on the new vault
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await access(join(vaultRoot, 'workspace', 'AGENTS.md'))
  await access(join(vaultRoot, 'private'))

  // the first capture is waiting in the inbox (no engine connected)
  const inbox = await readdir(join(vaultRoot, 'workspace', 'inbox'))
  expect(inbox.length).toBe(1)

  // The sky is home (Engram redesign) — the global connect banner carries the
  // "usable without AI" promise.
  await expect(page.getByTestId('connect-banner')).toContainText('No AI brain yet')
})
