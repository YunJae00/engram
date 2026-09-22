import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault, readRoutineLearning, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, paths: VaultPaths, botId: string
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  paths = await initVault(await mkdtemp(join(tmp, 'routine-skill-vault-')), { git: false })
  const responses = await mkdtemp(join(tmp, 'routine-skill-responses-'))
  await writeFile(join(responses, 'default.md'), 'Fixture answer: current inventory checked. No changes submitted.')
  await writeFile(join(responses, 'ROUTINE-LEARNING.json'), JSON.stringify({ name: 'Check inventory', goal: 'Ask for the current reporting period, read inventory and verify its timestamp. Do not submit changes.', does: 'Check current inventory.' }))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'routine-skill-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: responses, ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow({ timeout: 60_000 })
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
})
test.afterAll(async () => { await app?.close() })

async function send(text: string) {
  const input = page.getByTestId('bots-input')
  await input.fill(text); await input.press('Enter')
  await expect.poll(() => page.evaluate(() => window.engram.chatActive()), { timeout: 60_000 }).toEqual([])
  await expect(input).toHaveValue('')
}

test('starts only on explicit skill invocation and retains its draft when reopening the chat', async () => {
  await page.getByTestId('welcome-input').fill('/')
  await page.getByRole('button', { name: '/routine · Learn a routine from this chat' }).click()
  await page.getByTestId('welcome-input').press('Enter')
  await expect(page.getByTestId('routine-learning-bar')).toContainText('Learning routine · 0 turns')
  botId = (await page.evaluate(() => window.engram.botsList()))[0]!.id
  await send('Check the current inventory without submitting changes')
  await expect(page.getByTestId('routine-learning-bar')).toContainText('1 turn')
  await expect(page.getByTestId('bots-offer-keep-card')).toHaveCount(0)
  expect(await page.evaluate(() => window.engram.routinesList())).toEqual([])
  await page.reload()
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.getByTestId('routine-learning-bar')).toContainText('1 turn')
  const second = await page.evaluate(() => window.engram.botCreate({ name: 'Unrelated chat' }))
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${second.id}`).click()
  await expect(page.getByTestId('routine-learning-bar')).toHaveCount(0)
  await send('Read an unrelated note')
  expect(await readRoutineLearning(paths, second.id)).toBeNull()
  expect((await readRoutineLearning(paths, botId))?.requests).toEqual(['Check the current inventory without submitting changes'])
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${botId}`).click()
})

test('organizes an editable preview, preserves edits and saves without running or scheduling', async () => {
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review routine' })
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Check inventory', { timeout: 60_000 })
  await dialog.getByLabel('Instructions', { exact: true }).fill('Read current inventory, verify the timestamp and return a table. Never submit changes.')
  await dialog.getByRole('button', { name: 'Close routine review' }).click()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(dialog.getByLabel('Instructions', { exact: true })).toHaveValue(/return a table/)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(dialog).toHaveCSS('animation-name', 'none')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.setViewportSize({ width: 600, height: 800 })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(600)
    await expect.poll(async () => (await dialog.boundingBox())!.width).toBeLessThanOrEqual(568)
    expect(await dialog.evaluate(node => Math.abs(node.getBoundingClientRect().x + node.getBoundingClientRect().width / 2 - innerWidth / 2))).toBeLessThan(2)
    await expect(dialog.getByRole('button', { name: 'Save routine', exact: true })).toBeInViewport()
    const png = await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; await window.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 300)); return (await window.webContents.capturePage()).toPNG().toString('base64') })
    await writeFile(join(tmp, `routine-skill-${theme}.png`), Buffer.from(png, 'base64'))
  }
  const before = await page.evaluate(() => window.engram.botsList())
  await dialog.getByRole('button', { name: 'Save routine', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('routine-learning-bar')).toHaveCount(0)
  const saved = await page.evaluate(() => window.engram.routinesList())
  expect(saved).toHaveLength(1)
  expect(saved[0]!.task?.goal).toContain('return a table')
  expect(saved[0]!.lastRunAt).toBeUndefined()
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])
  expect(await page.evaluate(() => window.engram.botsList())).toEqual(before)
})

test('discard removes only the draft, not the chat or saved routines', async () => {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
  await send('/routine')
  await expect(page.getByTestId('routine-learning-bar')).toBeVisible()
  await page.getByRole('button', { name: 'Discard routine draft' }).click()
  await expect(page.getByTestId('routine-learning-bar')).toHaveCount(0)
  expect(await readRoutineLearning(paths, botId)).toBeNull()
  expect(await page.evaluate(() => window.engram.routinesList())).toHaveLength(1)
  await expect(page.getByTestId('bots-thread')).toContainText('current inventory')
})

test('split panes keep routine state attached to the selected conversation', async () => {
  await page.setViewportSize({ width: 1280, height: 840 })
  await send('/routine')
  await openActivity(page, 'mission')
  const tile = page.getByTestId('mission-tile-0')
  await expect(tile.getByTestId(`mini-chat-${botId}`)).toBeVisible()
  await expect(tile.getByTestId('routine-learning-bar')).toContainText('Learning routine')
  await tile.locator('.mission-change').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Unrelated chat', exact: true }).click()
  await expect(tile.getByTestId('routine-learning-bar')).toHaveCount(0)
  expect((await readRoutineLearning(paths, botId))?.phase).toBe('recording')
  await page.evaluate(id => window.engram.routineLearningAction(id, 'discard'), botId)
})
