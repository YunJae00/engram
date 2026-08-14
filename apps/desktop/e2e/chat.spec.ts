import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createNote, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// M6 acceptance: MockEngine streaming — ask → tokens render progressively →
// 📌 promotes the answer → a note is created by the capture pipeline.

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-chat-'))
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

test('ask → streamed tokens render → answer arrives', async () => {
  // wait for React to mount (keyboard listeners attach on mount)
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+l')
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await page.getByTestId('chat-input').fill('What is our deploy procedure?')
  await page.getByTestId('chat-send').click()

  const answer = page.locator('.chat-message.assistant').last()
  // Wait for the END of the canned answer, not its start: the small-vault chat
  // path streams the first token immediately, so a 'Mock answer' match can win
  // a race with token #1 still alone in the bubble. Only after the tail text
  // has rendered is the token count meaningful.
  await expect(answer).toContainText('Record this if you want it kept', { timeout: 30_000 })
  // streaming: the bubble accumulated multiple token events
  const tokens = Number(await answer.getAttribute('data-tokens'))
  expect(tokens).toBeGreaterThanOrEqual(2)
})

test('📌 record promotes the answer into a note via the pipeline', async () => {
  const notesBefore = (await readdir(paths.notes)).length
  await page.locator('.chat-message.assistant .pin-button').last().click()
  await expect
    .poll(async () => (await readdir(paths.notes)).length, { timeout: 30_000 })
    .toBeGreaterThan(notesBefore)
})

