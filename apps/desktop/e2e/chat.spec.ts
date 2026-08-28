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

  const composer = page.locator('.bots-write textarea')
  await expect(composer).toBeVisible()
  await composer.fill('What is our deploy procedure?')
  await composer.press('Enter')
  // A comet made with one press takes its name from its first words.
  await expect(page.locator('.bots-row.active')).toContainText('What is our deploy procedure?', { timeout: 60_000 })

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
  // The thread is held outside the view and refreshed from the transcript
  // main persists — this is what makes a comet a colleague, not a popup.
  await expect(answer).toContainText('Record this if you want it kept', { timeout: 15_000 })
})

test('the selected comet is remembered across tabs', async () => {
  await page.getByTestId('bots-new').click()
  await expect(page.locator('.bots-row.active')).toContainText('New comet')
  // Pick the comet that is NOT first in the rail, then leave and come back.
  await page.locator('.bots-row', { hasText: 'What is our deploy procedure?' }).click()
  await expect(page.locator('.bots-row.active')).toContainText('What is our deploy procedure?')
  await page.getByTestId('activity-brain').click()
  await expect(page.getByTestId('bots-view')).toHaveCount(0)
  await page.getByTestId('activity-bots').click()
  await expect(page.locator('.bots-row.active')).toContainText('What is our deploy procedure?')
  await expect(page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()).toContainText(
    'Record this if you want it kept',
  )
})

test('a question just sent and a draft not yet sent both survive a tab switch', async () => {
  const composer = page.locator('.bots-write textarea')
  await composer.fill('Where do we deploy from?')
  await composer.press('Enter')
  // Leave at once - before main has written anything to disk.
  await page.getByTestId('activity-list').click()
  await expect(page.getByTestId('bots-view')).toHaveCount(0)
  await page.getByTestId('activity-bots').click()
  await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').last()).toContainText('Where do we deploy from?')
  await expect(page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()).toContainText(
    'Record this if you want it kept',
    { timeout: 30_000 },
  )
  await composer.fill('unsent thought')
  await page.getByTestId('activity-sky').click()
  await page.getByTestId('activity-bots').click()
  await expect(page.locator('.bots-write textarea')).toHaveValue('unsent thought')
})
