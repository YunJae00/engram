import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, createTask, updateTask, initVault, listTasks, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Every conversation is a task that runs to the end, and the list shows only
// what is current: a conversation quiet for a day steps out of sight, not off disk.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths
let quietId = ''

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  paths = await initVault(await mkdtemp(join(REPO_TMP, 'e2e-tasks-')), { git: false })
  const quiet = await createBot(paths, { name: 'Last week expenses' })
  quietId = quiet.id
  await appendBotTurn(paths, quiet.id, { role: 'user', text: 'Total last week', at: new Date(Date.now() - 3 * 86_400_000).toISOString() })
  await appendBotTurn(paths, quiet.id, { role: 'assistant', text: '420.00 EUR', at: new Date(Date.now() - 3 * 86_400_000).toISOString() })
  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: paths.root,
      ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-tasks-userdata-')),
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'mock',
      ENGRAM_MOCK_DIR: MOCK_DIR,
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
  // The preload bridge exists once the shell has rendered; under load that can lag the first window.
  await page.getByTestId('shell').waitFor({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => window.engram?.vaultReady() ?? false), { timeout: 60_000 }).toBe(true)
})

test.afterAll(async () => {
  await app?.close()
})

test('a quiet conversation leaves the list but stays reachable', async () => {
  const quiet = page.getByTestId(`bot-${quietId}`)
  await expect(page.getByTestId('sidebar-earlier')).toHaveText('Show earlier (1)')
  await expect(quiet).toHaveCount(0)
  await page.getByTestId('sidebar-earlier').click()
  await expect(quiet).toBeVisible()
  await page.getByTestId('sidebar-earlier').click()
  await expect(quiet).toHaveCount(0)
})

test('a new conversation runs as a task to the end', async () => {
  await page.getByTestId('bots-new').click()
  await page.getByTestId('welcome-input').fill('Summarize the deploy procedure for the team')
  await page.getByTestId('welcome-input-send').click()
  await expect(page.locator('.bots-view .bubble-msg.assistant').last()).toContainText('Record this if you want it kept', { timeout: 30_000 })
  await expect.poll(async () => (await listTasks(paths)).map((task) => [task.goal, task.state]), { timeout: 30_000 }).toEqual([['Summarize the deploy procedure for the team', 'done']])
})

test('deferred decisions stay in the conversation and remain readable in narrow and dark layouts', async () => {
  const bot = await createBot(paths, { name: 'Invoice approvals' })
  const task = await createTask(paths, 'Review duplicate invoices', bot.id)
  await updateTask(paths, task.id, t => {
    t.state = 'waiting'
    t.approvals.push({ id: 'fixture-approval', words: 'Submit invoice review', url: 'https://example.test/invoices/42', host: 'example.test', at: new Date().toISOString() })
  })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'bots:changed' })
      window.webContents.send('engram:event', { type: 'tasks:changed' })
    }
  })
  await page.getByTestId(`bot-${bot.id}`).click()
  const card = page.getByTestId('task-approvals')
  await expect(card).toContainText('confirm on the current page')
  for (const [width, scheme] of [[1280, 'light'], [600, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
    await expect(card.getByRole('button', { name: 'Review and continue' })).toBeVisible()
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      await window.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 400))
      return (await window.webContents.capturePage()).toPNG().toString('base64')
    })
    await writeFile(join(REPO_TMP, `task-approvals-${width}-${scheme}.png`), Buffer.from(png, 'base64'))
  }
  await card.getByRole('button', { name: 'Decline', exact: true }).click()
  await expect.poll(async () => (await listTasks(paths)).find(t => t.id === task.id)?.approvals[0]?.answer).toBe('decline')
})
