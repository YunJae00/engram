import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault, type VaultPaths } from 'core'
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The product promise, end to end: "remember this" said to a comet → the
// answer carries a ✓ Remembered receipt (never the <engram:capture> plumbing)
// → the capture lands as a file in workspace/inbox/ → the librarian pipeline
// absorbs it into workspace/notes/.
//
// Chat prompts carry no "JOB: <kind>" marker, so MockEngine replays default.md.
// The shared fixtures/mock-responses/default.md has no capture block (chat.spec
// keys on its exact text), so this spec builds its OWN mock dir at runtime: a
// copy of every shared fixture (J1…J13 must stay intact for the librarian
// sweep) with default.md replaced by an answer that ends in a capture block.

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const SHARED_MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

const CAPTURE_TEXT = 'Standup moves to 09:30 every weekday starting 2026-08-18'
const CHAT_ANSWER = `Noted — I will keep that for you.\n\n<engram:capture>${CAPTURE_TEXT}</engram:capture>\n`

let app: ElectronApplication
let page: Page
let paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-chat-save-'))
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-chat-save-home-'))
  paths = await initVault(root, { git: false })

  // Spec-local mock dir: shared fixtures verbatim, default.md overridden.
  const mockDir = await mkdtemp(join(REPO_TMP, 'e2e-chat-save-mock-'))
  for (const file of await readdir(SHARED_MOCK_DIR)) {
    if (file === 'default.md') continue
    await copyFile(join(SHARED_MOCK_DIR, file), join(mockDir, file))
  }
  await writeFile(join(mockDir, 'default.md'), CHAT_ANSWER, 'utf8')

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_USERDATA: userData,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'mock',
      ENGRAM_MOCK_DIR: mockDir,
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  await app?.close()
})

test('remember said to a comet → ✓ Remembered receipt, plumbing never shown', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  // The keyboard listener attaches on mount — a single early Ctrl+L can be
  // silently lost on a fresh vault. Re-press until the comets tab is up.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+l')
    await expect(page.getByTestId('bots-view')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByTestId('bots-new').click()
  await page.getByTestId('bots-name').fill('Keeper')
  await page.getByTestId('bots-purpose').fill('Keeps whatever the user asks it to keep.')
  await page.getByTestId('bots-create-submit').click()
  const composer = page.locator('.bots-write textarea')
  await composer.fill('Please keep this decision for me')
  await composer.press('Enter')

  const answer = page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()
  // The receipt is appended by main in chat:done AFTER writeCapture succeeded —
  // seeing it proves the success path of the receipt logic (ipc.ts), not just
  // the canned prose.
  await expect(answer).toContainText('✓ Remembered', { timeout: 30_000 })
  // The capture markers are plumbing: stripped from the final text in main and
  // hidden mid-stream by the renderer. Neither the tag nor the stored text may
  // leak into the visible answer.
  await expect(answer).not.toContainText('engram:capture')
  await expect(answer).not.toContainText(CAPTURE_TEXT)
})

test('the capture lands as a file in the vault inbox', async () => {
  // writeCapture ran strictly before the receipt was broadcast, and the
  // librarian grace period (CAPTURE_GRACE_MS = 7s) keeps the file in inbox/
  // for a moment — but poll anyway so a fast absorb cannot flake us: the
  // capture is either still in inbox/ or already claimed into sources/.
  await expect
    .poll(
      async () => {
        const inbox = (await readdir(paths.inbox)).filter((f) => f.endsWith('-capture.md'))
        const sources = (await readdir(paths.sources).catch(() => [] as string[])).filter((f) =>
          f.endsWith('-capture.md'),
        )
        return [...inbox.map((f) => join(paths.inbox, f)), ...sources.map((f) => join(paths.sources, f))]
      },
      { timeout: 15_000 },
    )
    .not.toHaveLength(0)

  const inbox = (await readdir(paths.inbox)).filter((f) => f.endsWith('-capture.md'))
  const sources = (await readdir(paths.sources).catch(() => [] as string[])).filter((f) => f.endsWith('-capture.md'))
  const first = inbox[0] ?? sources[0]
  expect(first, 'capture file must exist in inbox/ or sources/').toBeTruthy()
  const file = inbox[0] ? join(paths.inbox, inbox[0]) : join(paths.sources, first!)
  expect(await readFile(file, 'utf8')).toContain(CAPTURE_TEXT)
})

test('the librarian sweep absorbs the capture into notes/', async () => {
  // Fresh vault → notes/ starts empty; the J1 fixture (copied verbatim into
  // the spec-local mock dir) lets the pipeline file the capture as a real
  // note. Grace is 7s, filing with the mock engine is fast — 90s is generous.
  // If this ever proves flaky on CI, the inbox-persistence assertion above is
  // the fallback guarantee; today absorption completes reliably, so we assert
  // the full pipeline.
  await expect
    .poll(async () => (await readdir(paths.notes)).filter((f) => f.endsWith('.md')).length, { timeout: 90_000 })
    .toBeGreaterThan(0)
  // The absorbed original moved out of inbox/ into sources/ — the scrap is
  // filed, not duplicated.
  await expect
    .poll(async () => (await readdir(paths.inbox)).filter((f) => f.endsWith('-capture.md')).length, {
      timeout: 15_000,
    })
    .toBe(0)
})
