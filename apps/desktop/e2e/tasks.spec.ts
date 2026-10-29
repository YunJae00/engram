import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, createTask, updateTask, initVault, listTasks, localDay, loadBots, addBotTask, addNotice, writeHabits, readHabits, readNotices, type VaultPaths } from 'core'
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
      ENGRAM_TEST_FAST_SCHEDULE: '1',
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
  await page.getByTestId('sidebar-create').click(); await page.getByTestId('bots-new').click()
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
  await expect(card).toContainText('Submit invoice review')
  await expect(card.getByTestId('task-approval-fixture-approval')).toHaveAttribute('title', /confirm on the current page/)
  for (const [width, scheme] of [[1280, 'light'], [600, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
    await expect(card.getByRole('button', { name: 'Go ahead' })).toBeVisible()
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
  await expect(page.locator('.toast')).toHaveCSS('pointer-events', 'none')
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

test('saved multiline questions render real paragraphs once and retain literal code escapes', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const bot = await createBot(paths, { name: 'Time report draft' })
  const question = String.raw`Today has no recorded hours.\n\n1) Draft the items\n2) Enter actual hours\n\nWhich option?` + '\n\n```js\n' + String.raw`const marker = '\n\n'` + '\n```'
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'Draft today’s time report', at: new Date().toISOString() })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: question, at: new Date().toISOString() })
  const task = await createTask(paths, 'Draft a time report', bot.id)
  await updateTask(paths, task.id, value => { value.state = 'waiting'; value.question = question; value.result = question })
  await page.reload()
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${bot.id}`).click()
  const answer = page.getByTestId('bots-thread').locator('.bubble-msg.assistant').last()
  await expect(answer.locator('ol li')).toHaveText(['Draft the items', 'Enter actual hours'])
  await expect(answer.locator('pre code')).toHaveText(String.raw`const marker = '\n\n'`)
  await expect(page.getByText('Your answer is needed', { exact: true })).toHaveCount(0)
  const text = await answer.locator('.bubble-msg-body > p').allTextContents()
  expect(text.join(' ')).not.toContain(String.raw`\n`)
  await page.screenshot({ path: join(REPO_TMP, 'question-newlines.png') })
  expect(await page.evaluate(id => window.engram.botTranscript(id), bot.id)).toContainEqual(expect.objectContaining({ role: 'assistant', text: question }))
  await updateTask(paths, task.id, value => { value.question = String.raw`Choose the next step.\n\n1) Keep the draft\n2) Add hours\n\n<img src=x onerror=alert(1)>` })
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'tasks:changed' }) })
  const card = page.locator('.chat-approval')
  await expect(card.locator('ol li')).toHaveText(['Keep the draft', 'Add hours'])
  await expect(card).not.toContainText(String.raw`\n`)
  await expect(card.locator('img')).toHaveCount(0)
  await expect(card).toContainText('<img src=x onerror=alert(1)>')
  await updateTask(paths, task.id, value => { value.state = 'done'; delete value.question })
})

test('scheduled turns open new conversations, notify, and leave existing approvals and drafts alone', async () => {
  const waiting = await page.evaluate(() => window.engram.botCreate({ name: 'Waiting schedule' }))
  const pending = await createTask(paths, 'Needs approval', waiting.id)
  await updateTask(paths, pending.id, task => { task.state = 'waiting'; task.question = 'May I send this?' })
  const ready = await page.evaluate(() => window.engram.botCreate({ name: 'Scheduled fixture' }))
  const now = new Date()
  const schedule = { days: [], hour: now.getHours(), minute: now.getMinutes(), on: localDay(now) }
  await addBotTask(paths, waiting.id, { name: 'Keep waiting', goal: 'Scheduled reminder', schedule })
  await addBotTask(paths, ready.id, { name: 'Due now', goal: 'Summarize the deploy procedure for the team', schedule })
  await page.getByTestId(`bot-${ready.id}`).click()
  await page.getByTestId('bots-input').fill('Keep my draft')
  await expect.poll(async () => (await readNotices(paths)).filter(item => item.kind === 'scheduled' && !item.running).length, { timeout: 15_000 }).toBe(2)
  await expect(page.getByTestId('bots-input')).toHaveValue('Keep my draft')
  expect((await listTasks(paths)).find(task => task.id === pending.id)?.state).toBe('waiting')
  expect((await loadBots(paths)).find(bot => bot.id === waiting.id)?.tasks).toHaveLength(0)
  const notices = await readNotices(paths)
  expect(notices.every(item => item.botId !== ready.id && item.botId !== waiting.id)).toBe(true)
  await page.getByTestId('notices-bell').click()
  await page.getByTestId('notices-item').filter({ hasText: 'Due now' }).click()
  await expect(page.getByTestId('bubble-scheduled')).toBeVisible()
  expect((await readNotices(paths)).find(item => item.title === 'Due now')?.read).toBe(true)
  await updateTask(paths, pending.id, task => { task.state = 'done'; delete task.question })
})

test('the bell cancels schedules and opens a habit only once with a localized decision', async () => {
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Weekly schedule' }))
  const task = await addBotTask(paths, bot.id, { name: 'Weekly report', goal: 'Summarize the week', schedule: { days: [1], hour: 1, minute: 0 } })
  await writeHabits(paths, { fixture: { state: 'draft', at: new Date().toISOString(), times: 3, labels: ['Mail', 'Sheets'], draft: { title: '문의 기록', description: '문의 내용을 정리해요', body: '## 순서\n문의 내용을 시트에 적어요.\n## 질문\n무엇을 적나요?' } } })
  const notice = await addNotice(paths, { kind: 'habit', key: 'fixture', title: '문의 기록', text: '이 순서로 저장할까요?' })
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engram:event', { type: 'notices:changed' }) })
  await page.getByTestId('notices-bell').click()
  await page.getByRole('button', { name: 'Stop “Weekly report”' }).click()
  await expect(page.getByRole('button', { name: 'Stop “Weekly report”' })).toHaveCount(0)
  expect((await loadBots(paths)).find(one => one.id === bot.id)?.tasks?.some(one => one.id === task.id)).toBe(false)
  await page.getByTestId('notices-item').filter({ hasText: '문의 기록' }).click()
  await expect(page.getByTestId('habit-ask-keep')).toHaveText('이대로 저장')
  const opened = await page.evaluate(async id => Promise.all([window.engram.noticesOpen(id), window.engram.noticesOpen(id)]), notice.id)
  expect(opened[0]).toBe(opened[1])
  await page.getByTestId('habit-ask-no').click()
  await expect(page.getByTestId('habit-ask-done')).toBeVisible()
  expect((await readHabits(paths)).fixture?.state).toBe('dismissed')
})
