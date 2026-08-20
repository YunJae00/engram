import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createNote, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The comets tab is the app's conversation surface now: create a comet, ask
// it a question, watch the MockEngine's canned answer stream in, and confirm
// the conversation survives leaving the tab (transcripts persist in main).

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-comet-'))
  paths = await initVault(root, { git: false })
  await createNote(paths, { id: 'n-deploy-0001', body: '# Deploy procedure\n\nFully automated to production.' })

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'mock',
      ENGRAM_MOCK_DIR: MOCK_DIR,
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  await app?.close()
})

test('create a comet, ask it, and watch the answer stream in', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  // Ctrl+L is the door to the comets tab; the listener attaches on mount, so
  // an early press can be lost — re-press until the view is up.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+l')
    await expect(page.getByTestId('bots-view')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByTestId('bots-new').click()
  await page.getByTestId('bots-name').fill('Deploy keeper')
  await page.getByTestId('bots-purpose').fill('Answers questions about how we deploy.')
  await page.getByTestId('bots-create-submit').click()

  const composer = page.locator('.bots-write textarea')
  await expect(composer).toBeVisible()
  await composer.fill('What is our deploy procedure?')
  await composer.press('Enter')

  const answer = page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()
  // Wait for the END of the canned answer, not its start — only then has the
  // stream fully rendered.
  await expect(answer).toContainText('Record this if you want it kept', { timeout: 30_000 })
})

test('the conversation survives leaving and re-entering the tab', async () => {
  await page.getByTestId('activity-sky').click()
  await expect(page.getByTestId('bots-view')).toHaveCount(0)
  await page.getByTestId('activity-bots').click()
  const answer = page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()
  // The transcript is persisted by main and reloaded on mount, not held in
  // renderer state — this is what makes a comet a colleague, not a popup.
  await expect(answer).toContainText('Record this if you want it kept', { timeout: 15_000 })
})
