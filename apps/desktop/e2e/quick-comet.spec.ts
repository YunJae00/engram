import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

let app: ElectronApplication, page: Page, popup: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'quick-comet-vault-')), responses = await mkdtemp(join(tmp, 'quick-comet-responses-'))
  await initVault(vault, { git: false })
  await writeFile(join(responses, 'default.md'), 'Your quick Comet is ready. No external changes were made.')
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'quick-comet-data-')), ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: responses, ENGRAM_HIDDEN: '1', ENGRAM_DEVELOPER_FIXTURE: '0', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
})
test.afterAll(async () => { await app?.close() })
async function visible() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#quick'))?.isVisible() ?? false)
}
async function openPopup() {
  await page.evaluate(() => window.engram.showQuickComet())
  popup = app.windows().find(window => window.url().endsWith('#quick'))!
  await expect(popup.getByTestId('quick-capture')).toBeVisible()
  await expect.poll(visible).toBe(true)
}

test('Developers entry points are hidden without removing stored preferences', async () => {
  await expect(page.getByTestId('activity-developers')).toHaveCount(0)
  await openActivity(page, 'settings')
  for (const size of [{ width: 1000, height: 740 }, { width: 600, height: 800 }]) {
    await page.setViewportSize(size)
    const close = page.getByRole('button', { name: 'Close settings', exact: true })
    await expect(close).toBeVisible()
    expect((await close.boundingBox())!.y).toBeGreaterThanOrEqual(56)
    expect((await page.getByTestId('settings-view').boundingBox())!.y).toBeGreaterThanOrEqual(56)
    await page.screenshot({ path: join(tmp, `settings-safe-controls-${size.width}.png`) })
  }
  await page.setViewportSize({ width: 1000, height: 740 })
  await expect(page.getByTestId('settings-nav-developers')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Developers', exact: true })).toHaveCount(0)
  await page.getByTestId('settings-nav-help').click()
  await expect(page.getByText('New Comet near the pointer (global)')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.dispatchEvent(new Event('engram:open-developers')))
  await expect(page.getByTestId('developers-view')).toHaveCount(0)
  expect(await page.evaluate(() => window.engram.devState().then(state => state.repos))).toEqual([])
})

test('popup is compact, focused, preserves dismissed drafts and supports new lines', async () => {
  await openPopup()
  const input = popup.getByTestId('quick-input')
  await expect(input).toBeFocused()
  await expect(popup.getByRole('button')).toHaveCount(3)
  await popup.screenshot({ path: join(tmp, 'quick-comet-empty.png') })
  await expect(popup.getByRole('button', { name: 'Start Comet', exact: true })).toBeDisabled()
  await input.fill('Keep this draft')
  await input.press('Shift+Enter')
  await input.type('Second line')
  await expect(input).toHaveValue('Keep this draft\nSecond line')
  await input.press('Escape')
  await expect.poll(visible).toBe(false)
  await openPopup()
  await expect(input).toHaveValue('Keep this draft\nSecond line')
  await expect(input).toBeFocused()
  const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().endsWith('#quick'))!
    return { bounds: window.getBounds(), area: screen.getDisplayMatching(window.getBounds()).workArea }
  })
  expect(bounds.bounds.width).toBeLessThanOrEqual(480)
  expect(bounds.bounds.x).toBeGreaterThanOrEqual(bounds.area.x)
  expect(bounds.bounds.y + bounds.bounds.height).toBeLessThanOrEqual(bounds.area.y + bounds.area.height)
  await popup.screenshot({ path: join(tmp, 'quick-comet-light.png') })
  await popup.evaluate(async () => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: 'dark' }))
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark')
  await popup.screenshot({ path: join(tmp, 'quick-comet-dark.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(one => one.webContents.getURL().endsWith('#quick'))!.emit('blur'))
  await expect.poll(visible).toBe(false)
})

test('the add menu expands above the input, attaches files and opens the app without losing the draft', async () => {
  await openPopup()
  await popup.getByTestId('quick-input').fill('Use this attachment')
  await popup.getByRole('button', { name: 'Quick chat actions', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Attach files', exact: true })).toBeVisible()
  const menu = (await popup.getByRole('group', { name: 'Quick chat actions' }).boundingBox())!
  expect(menu.y + menu.height).toBeLessThan((await popup.locator('.quick-bar').boundingBox())!.y)
  await popup.screenshot({ path: join(tmp, 'quick-comet-menu.png') })
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(tmp, 'quick-comet-attachment.txt'))
  await writeFile(join(tmp, 'quick-comet-attachment.txt'), 'Quick attachment evidence')
  await popup.getByRole('button', { name: 'Attach files', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Remove quick-comet-attachment.txt' })).toBeVisible()
  await expect.poll(visible).toBe(true)
  await popup.getByRole('button', { name: 'Quick chat actions', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#quick'))!.minimize())
  await popup.getByRole('button', { name: 'Open Engram', exact: true }).click()
  await expect.poll(visible).toBe(false)
  expect(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#quick'))!
    return window.isVisible() && !window.isMinimized()
  })).toBe(true)
  await openPopup()
  await expect(popup.getByTestId('quick-input')).toHaveValue('Use this attachment')
  await popup.getByTestId('quick-input').press('Enter')
  await expect.poll(visible).toBe(false)
  await expect.poll(() => page.evaluate(async () => {
    const bot = (await window.engram.botsList()).at(-1)!
    return (await window.engram.botTranscript(bot.id)).some(turn => turn.role === 'user' && turn.attachments?.length === 1)
  })).toBe(true)
})

test('invalid input creates nothing; Enter creates one Comet and starts the normal task', async () => {
  const initial = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  for (const text of ['', ' ', 'x'.repeat(20_001)]) {
    expect(await page.evaluate(text => window.engram.quickComet(text).then(() => false).catch(() => true), text)).toBe(true)
  }
  expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(initial)
  await openPopup()
  await popup.getByTestId('quick-input').fill('Say hello from my quick Comet')
  await popup.getByTestId('quick-input').press('Enter')
  await expect.poll(visible).toBe(false)
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(initial + 1)
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.locator('.conversation-title svg')).toHaveCount(0)
  await expect(page.getByTestId('bots-thread').getByText('Say hello from my quick Comet', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => {
    const bot = (await window.engram.botsList()).at(-1)!
    const turns = await window.engram.botTranscript(bot.id)
    return turns.some(turn => turn.role === 'assistant')
  }), { timeout: 60_000 }).toBe(true)
  await openPopup()
  await expect(popup.getByTestId('quick-input')).toHaveValue('')
  await popup.getByTestId('quick-input').press('Escape')
})

test('missing AI keeps the draft, and composition Enter never submits', async () => {
  const initial = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  await app.evaluate(() => { process.env['ENGRAM_ENGINE'] = 'none' })
  await openPopup()
  const input = popup.getByTestId('quick-input')
  await input.fill('한글 작성 중')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(input).toHaveValue('한글 작성 중')
  await expect(popup.getByRole('alert')).toHaveCount(0)
  await input.press('Enter')
  await expect(popup.getByRole('alert')).toContainText('Connect an AI')
  await expect(input).toHaveValue('한글 작성 중')
  await expect.poll(visible).toBe(true)
  expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(initial)
  await popup.getByTestId('quick-input').press('Escape')
})

test('split chats keep spoken progress after a tool starts and show one final result', async () => {
  const bot = await page.evaluate(() => window.engram.botsList().then(bots => bots.at(-1)!))
  await openActivity(page, 'mission')
  const tile = page.getByTestId(`mini-chat-${bot.id}`)
  await expect(tile).toBeVisible()
  await app.evaluate(({ BrowserWindow }, id) => {
    const channel = `bot-${id}`, window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#quick'))!
    for (const event of [{ type: 'comet:continue', botId: id }, { type: 'comet:working', channel, working: true }, { type: 'chat:token', channel, text: 'Checking your work now.' }, { type: 'chat:token', channel, text: '', reset: true }, { type: 'comet:step', channel, line: 'read_open_page: Current page' }]) window.webContents.send('engram:event', event)
  }, bot.id)
  await expect(tile.getByText('Checking your work now.', { exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }, id) => {
    const channel = `bot-${id}`, window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#quick'))!
    for (const event of [{ type: 'chat:done', channel, text: 'One final checked result.' }, { type: 'comet:working', channel, working: false }]) window.webContents.send('engram:event', event)
  }, bot.id)
  await expect(tile.getByText('Checking your work now.', { exact: true })).toBeVisible()
  await expect(tile.getByText('One final checked result.', { exact: true })).toHaveCount(1)
})
