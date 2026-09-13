import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, createNote, fileWorkTools, initVault, recordBotSites, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

async function screenshot(name: string) {
  await expect(page.locator('#boot')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish()
    }
  })
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(REPO_TMP, name), Buffer.from(png, 'base64'))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
}

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
      // Its own userData - shared state with the installed app is how a test
      // boots against a vault that app is holding open.
      ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-chat-userdata-')),
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'mock',
      ENGRAM_MOCK_DIR: MOCK_DIR,
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('models:list')
    ipcMain.handle('models:list', () => Array.from({ length: 12 }, (_, index) => ({
      value: `fixture-${index}`, label: `Model ${index + 1}`, detail: 'A long model description for checking menu boundaries and scrolling.',
    })))
  })
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

  const composer = page.getByTestId('welcome-input')
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

test('starts fresh without losing chats, sends from welcome, and renders long titles and code', async () => {
  const previous = await page.evaluate(() => window.engram.botsList())
  await page.reload()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  expect((await page.evaluate(() => window.engram.botsList())).length).toBe(previous.length)
  await page.setViewportSize({ width: 1280, height: 840 })
  await screenshot('ui-welcome.png')
  await expect(page.getByTestId('comet-welcome').getByRole('heading')).toHaveText('A spark starts here.')
  await expect(page.locator('.welcome-starters')).toHaveCount(0)
  await page.getByTestId('welcome-input').fill('Summarize our deploy procedure')
  await page.getByTestId('welcome-input-send').click()
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect(page.locator('.bots-view .bubble-msg.assistant').last()).toContainText('Record this if you want it kept', { timeout: 30_000 })
  expect((await page.evaluate(() => window.engram.botsList())).length).toBe(previous.length + 1)
  const bot = await createBot(paths, { name: '팀의 주간 보고서와 제안서 작성 결과를 검토하고 수정하는 아주 긴 대화 제목' })
  await appendBotTurn(paths, bot.id, { role: 'assistant', at: new Date().toISOString(), text: '수정된 제안서의 백업은 `Engram_도입_제안.pptx.e1b9abd7fa904dd291589bfd2e0d7de6.bak`입니다.\n\n```python\nif ready:\n    run()\n```' })
  await page.reload()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await page.getByTestId(`bot-${bot.id}`).click()
  const title = page.getByTestId(`bot-${bot.id}`).locator('span').last()
  await expect(title).toHaveCSS('text-overflow', 'ellipsis')
  expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  await expect(page.locator('.answer-code pre')).toContainText('    run()')
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { document.documentElement.dataset.copied = value } } }))
  await page.getByRole('button', { name: 'Copy code', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.dataset.copied)).toBe('if ready:\n    run()\n')
  const geometry = await page.locator('.bots-chat').evaluate((node) => {
    const composer = node.querySelector('.bots-write')!.getBoundingClientRect()
    const thread = node.querySelector('.bots-thread')!
    const style = getComputedStyle(thread)
    return { composer: composer.width, content: thread.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
  })
  expect(geometry.composer).toBeGreaterThan(geometry.content + 30)
  await screenshot('ui-conversation.png')
  await page.getByTestId('activity-settings').click()
  await expect(page.getByTestId('setting-autostart')).toBeVisible()
  await page.getByTestId('settings-nav-computer').click()
  await page.evaluate(async () => { await window.engram.settingsSet({ ...await window.engram.settingsGet(), computerUse: true }) })
  await expect(page.getByTestId('setting-computer-use')).toBeChecked()
  await screenshot('ui-settings.png')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await page.evaluate(() => window.engram.settingsGet())).computerUse).toBe(true)
  await page.locator('.bots-row', { hasText: 'What is our deploy procedure?' }).first().click()
})

test('welcome model choices stay inside the main surface at every window size', async () => {
  await page.reload()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  for (const size of [{ width: 1280, height: 840 }, { width: 948, height: 620 }, { width: 620, height: 480 }]) {
    await page.setViewportSize(size)
    if (size.width <= 900 && await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-close').click()
    const picker = page.getByTestId('comet-welcome').getByTestId('model-picker')
    await picker.click()
    const menu = page.getByTestId('model-picker-menu')
    await expect(menu).toBeVisible()
    await expect.poll(() => menu.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const host = document.querySelector('.bots-main')!.getBoundingClientRect()
      return rect.left >= host.left && rect.right <= host.right && rect.top >= host.top && rect.bottom <= innerHeight
    })).toBe(true)
    await screenshot(`ui-welcome-model-${size.width}.png`)
    await expect(page.getByTestId('model-pick-fixture-11')).toHaveCount(1)
    await page.getByTestId('model-pick-fixture-11').click()
    await expect(picker).toHaveText('Model 12')
    await picker.click()
    await page.getByTestId('model-pick-auto').click()
    await expect(picker).toHaveText('Auto')
    await picker.click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }
  await page.setViewportSize({ width: 1280, height: 840 })
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.locator('.bots-row', { hasText: 'What is our deploy procedure?' }).first().click()
})

test('the conversation survives leaving and re-entering the tab', async () => {
  await page.getByTestId('activity-sky').click()
  // The view stays mounted and hidden now - coming back is instant and the
  // thread is exactly where it was.
  await expect(page.getByTestId('bots-view')).toBeHidden()
  await page.getByTestId('activity-bots').click()
  const answer = page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()
  // The thread is held outside the view and refreshed from the transcript
  // main persists — this is what makes a comet a colleague, not a popup.
  await expect(answer).toContainText('Record this if you want it kept', { timeout: 15_000 })
})

test('composer tools stay in the chat surface and open away from the sidebar', async () => {
  await expect(page.locator('.bots-head button')).toHaveCount(0)
  const memory = page.getByTestId('bots-memory-toggle')
  await expect(memory).toBeVisible()
  await expect(memory).toContainText('Cosmos')
  await memory.click()
  const memoryPanel = page.locator('.bots-memory')
  await expect(memoryPanel).toBeVisible()
  const [memoryBox, composerBox] = await Promise.all([memoryPanel.boundingBox(), page.locator('.bots-write > .chat-write').boundingBox()])
  expect(memoryBox!.y + memoryBox!.height).toBeLessThanOrEqual(composerBox!.y)
  await memory.click()

  const picker = page.getByTestId('model-picker')
  if (await picker.isEnabled()) {
    await picker.click()
    const menu = page.getByTestId('model-picker-menu')
    await expect(menu).toBeVisible()
    const [menuBox, sidebarBox] = await Promise.all([menu.boundingBox(), page.getByTestId('app-sidebar').boundingBox()])
    expect(menuBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width)
    await page.keyboard.press('Escape')
  }
})

test('the selected comet is remembered across tabs', async () => {
  const count = await page.locator('.bots-row').count()
  await page.getByTestId('bots-new').click()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await expect(page.locator('.bots-row')).toHaveCount(count)
  // Pick the comet that is NOT first in the rail, then leave and come back.
  await page.locator('.bots-row', { hasText: 'What is our deploy procedure?' }).click()
  await expect(page.locator('.bots-row.active')).toContainText('What is our deploy procedure?')
  await page.getByTestId('activity-list').click()
  // The view stays mounted and hidden now - coming back is instant and the
  // thread is exactly where it was.
  await expect(page.getByTestId('bots-view')).toBeHidden()
  await page.getByTestId('activity-bots').click()
  await expect(page.locator('.bots-row.active')).toContainText('What is our deploy procedure?')
  await expect(page.locator('[data-testid="bots-view"] .bubble-msg.assistant').last()).toContainText(
    'Record this if you want it kept',
  )
})

test('a question just sent and a draft not yet sent both survive a tab switch', async () => {
  const composer = page.locator('.bots-write textarea')
  await expect(composer).toHaveCount(1)
  await composer.fill('Where do we deploy from?')
  await composer.press('Enter')
  // Leave at once - before main has written anything to disk.
  await page.getByTestId('activity-list').click()
  // The view stays mounted and hidden now - coming back is instant and the
  // thread is exactly where it was.
  await expect(page.getByTestId('bots-view')).toBeHidden()
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

test('created file links reveal only generated artifacts and reject escaping links', async () => {
  const bot = await createBot(paths, { name: 'File output verification' })
  const tool = fileWorkTools({ directory: join(paths.cache, 'artifacts'), approveRead: async () => false }).find((tool) => tool.name === 'file_create_copy')!
  const artifact = JSON.parse(await tool.run({ name: '검증 결과.json', content: '{"verified":true}' }, { task: 'Create a test artifact.' })) as { path: string; markdownLink: string }
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `${artifact.markdownLink}\n\n[Unavailable output](engram-artifact:../outside.txt)`, at: new Date().toISOString() })
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (path: string) => { (globalThis as unknown as { revealedArtifact: string }).revealedArtifact = path }
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId('activity-bots').click()
  await page.locator('.bots-row', { hasText: 'File output verification' }).click()
  await page.getByRole('link', { name: '검증 결과.json', exact: true }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { revealedArtifact: string }).revealedArtifact)).toBe(artifact.path)
  await page.getByRole('link', { name: 'Unavailable output', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This output file is unavailable')
  expect(await app.evaluate(() => (globalThis as unknown as { revealedArtifact: string }).revealedArtifact)).toBe(artifact.path)
})

test('conversation keeps narration between compact activity groups and shows visited website icons', async () => {
  await expect(page.getByTestId('bots-new')).toBeEnabled({ timeout: 60_000 })
  const bot = await createBot(paths, { name: 'Research and review' })
  await recordBotSites(paths, bot.id, ['https://example.com/research'])
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', () => ({ ok: true }))
    ipcMain.removeHandler('site:icon')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const header = Buffer.alloc(22)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(1, 4)
    header[6] = header[7] = 1
    header.writeUInt16LE(1, 10)
    header.writeUInt16LE(32, 12)
    header.writeUInt32LE(png.length, 14)
    header.writeUInt32LE(22, 18)
    ipcMain.handle('site:icon', () => `data:image/x-icon;base64,${Buffer.concat([header, png]).toString('base64')}`)
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${bot.id}`).click()
  await expect(page.getByTestId(`bot-${bot.id}`).locator('img.site-icon')).toBeVisible()
  expect(await page.getByTestId(`bot-${bot.id}`).locator('img.site-icon').evaluate(async (node: HTMLImageElement) => { await node.decode(); return node.naturalWidth })).toBe(1)
  await page.getByTestId('bots-input').fill('Compare the options and prepare a short review.')
  await page.getByTestId('bots-input').press('Enter')
  const lines = ['said: I will check the source and compare the available options.', 'open_page: https://example.com/research', 'read_open_page: https://example.com/research', 'said: The source is checked. I am now preparing the review.', 'file_create_copy: review.md']
  await app.evaluate(({ BrowserWindow }, { id, lines }) => {
    for (const line of lines) BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:step', channel: `bot-${id}`, line })
  }, { id: bot.id, lines })
  const work = page.getByTestId('comet-work')
  await expect(work.locator('.comet-work-lines > li')).toHaveCount(4)
  await expect(work.locator('.comet-work-lines > li').nth(0)).toContainText('I will check the source')
  await expect(work.locator('.comet-work-lines > li').nth(2)).toContainText('The source is checked')
  await expect(work.locator('.work-group')).toHaveCount(2)
  await expect(work.locator('.work-group').first()).not.toHaveAttribute('open')
  await work.locator('.work-group summary').first().click()
  await expect(work.locator('.work-group').first().locator('ol > li')).toHaveCount(2)
  await work.locator('.work-group summary').first().click()
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', {
    type: 'chat:done', channel: `bot-${id}`, text: '## The review is ready\n\nThe options are compared and the source is available for your review.\n\n- Check the assumptions before choosing.\n- Keep the original document unchanged.\n\nSource: https://example.com/research\n\nBackup: `검토_결과.pptx.e1b9abd7fa904dd291589bfd2e0d7de6.bak`',
  }), bot.id)
  await expect(page.getByTestId('comet-work-done')).toContainText('Activity · 3 actions')
  await expect(page.locator('.answer-sites .answer-site')).toHaveText('example.com')
  await expect(page.locator('.answer-sites img.site-icon')).toBeVisible()
  expect(await page.locator('.bubble-msg-body h2').evaluate(node => parseFloat(getComputedStyle(node).fontSize) / parseFloat(getComputedStyle(node.parentElement!).fontSize))).toBeCloseTo(1.12)
  await page.getByRole('button', { name: 'Hide the page panel', exact: true }).click()
  await expect(page.locator('.web-pane')).toBeHidden()
  await screenshot('ui-conversation-activity.png')
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await screenshot('ui-conversation-activity-dark.png')
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await page.setViewportSize({ width: 620, height: 720 })
  if (await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-close').click()
  expect(await page.locator('.bots-thread').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await screenshot('ui-conversation-activity-compact.png')
})
