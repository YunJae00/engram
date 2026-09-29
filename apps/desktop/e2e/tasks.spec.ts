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
  await expect(page.getByTestId('sidebar-earlier')).toHaveAttribute('aria-expanded', 'false')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByTestId('sidebar-earlier').click()
  await expect(quiet).toBeVisible()
  await expect(page.getByTestId('sidebar-earlier')).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('sidebar-earlier').click()
  await expect(quiet).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test('a new conversation runs as a task to the end', async () => {
  await page.getByTestId('bots-new').click()
  await page.getByTestId('welcome-input').fill('Summarize the deploy procedure for the team')
  await page.getByTestId('welcome-input-send').click()
  await expect(page.locator('.bots-view .bubble-msg.assistant').last()).toContainText('Record this if you want it kept', { timeout: 30_000 })
  await expect.poll(async () => (await listTasks(paths)).map((task) => [task.goal, task.state]), { timeout: 30_000 }).toEqual([['Summarize the deploy procedure for the team', 'done']])
})

test('an answer does not unlock the composer while its task is still finishing', async () => {
  const task = (await listTasks(paths))[0]!
  await app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'comet:working', channel: `bot-${botId}`, working: true })
      window.webContents.send('engram:event', { type: 'chat:done', channel: `bot-${botId}`, text: 'Initial answer' })
    }
  }, task.botId)
  await expect(page.locator('.bots-view .bubble-stop')).toBeVisible()
  await expect(page.getByTestId('bots-thinking')).toBeVisible()
  await app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'comet:step', channel: `bot-${botId}`, line: 'read_open_page: ' })
      window.webContents.send('engram:event', { type: 'comet:observed', channel: `bot-${botId}` })
    }
  }, task.botId)
  await expect(page.getByTestId('bots-thinking')).toContainText('Thinking')
  await expect(page.getByTestId('bots-thinking')).not.toContainText('Reading the page')
  await expect(page.getByTestId('bots-thinking')).toContainText('Total')
  await app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('engram:event', { type: 'comet:working', channel: `bot-${botId}`, working: false })
  }, task.botId)
  await expect(page.locator('.bots-view .bubble-stop')).toHaveCount(0)
  await expect(page.getByTestId('bots-thinking')).toHaveCount(0)
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

test('questions offer readable keyboard choices and completion notices without exposing task contents', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Question fixture' }))
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'Which approach?', at: new Date().toISOString() })
  const task = await createTask(paths, 'Choose an approach', bot.id)
  await updateTask(paths, task.id, value => { value.state = 'waiting'; value.question = 'Which approach?' })
  await page.getByTestId(`bot-${bot.id}`).click()
  await expect(page.getByTestId('bots-input')).toBeVisible()
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'chat:offer', channel: `bot-${id}`, offer: { kind: 'asked', question: 'Which approach?', options: ['Keep the existing workflow and prepare a read-only preview first', 'Allow editing after reviewing the preview'] } })
      window.webContents.send('engram:event', { type: 'task:notice', message: 'Task done' })
    }
  }, bot.id)
  await expect(page.locator('.toast')).toHaveText('Task done')
  const card = page.getByTestId('bots-choices')
  await expect(card).toContainText('Your answer')
  await expect(page.locator('.bots-view .chat-approval')).toHaveCount(0)
  await page.getByTestId('bots-choice-0').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('bots-choice-1')).toBeFocused()
  for (const [width, scheme] of [[1280, 'light'], [600, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
    await expect(card).toBeVisible()
    await expect(page.locator('.bots-chat')).toHaveCSS('animation-name', 'none')
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    // Hidden windows can pause color transitions between compositor frames.
    await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish() })
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      await window.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 300))
      return (await window.webContents.capturePage()).toPNG().toString('base64')
    })
    await writeFile(join(REPO_TMP, `comet-question-${width}-${scheme}.png`), Buffer.from(png, 'base64'))
  }
  await page.getByTestId('bots-choice-0').click()
  await expect(card).toHaveCount(0)
  await expect(page.locator('.bots-view .bubble-msg.user').last()).toContainText('Keep the existing workflow')
})
