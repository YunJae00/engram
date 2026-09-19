import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DevelopersApi, DevUpdate } from '../src/shared/developers.js'

let app: ElectronApplication, page: Page, project: string
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'dev-e2e-vault-')), userData = await mkdtemp(join(tmp, 'dev-e2e-data-'))
  project = await mkdtemp(join(tmp, 'dev-e2e-project-'))
  await initVault(vault, { git: false })
  await writeFile(join(project, 'example.ts'), 'export const answer = 42\n')
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1360, height: 900 })
})

async function renderTaskFixture() {
  await page.setViewportSize({ width: 1360, height: 900 })
  await page.getByTestId('workspace-switcher').click()
  await page.getByTestId('activity-developers').click()
  const id = await page.evaluate(async () => {
    const api = (window as unknown as { engram: DevelopersApi }).engram, state = await api.devState()
    return (await api.devCreate({ repoId: state.repos[0]!.id, provider: 'codex', model: '', mode: 'review', isolate: false })).id
  })
  await page.locator('.dev-task-link').filter({ hasText: 'New task' }).click()
  const update: DevUpdate = { id, state: 'waiting', runtimeId: 'fixture', usage: { input: 1200, output: 240 }, items: [
    { id: 'request', kind: 'user', text: 'Fix the off-by-one error and add a focused check.' },
    { id: 'response', kind: 'assistant', text: 'The boundary includes one extra item. The proposed change is:\n\n```ts\nreturn items.slice(0, limit)\n```\n\nI will keep the existing public API unchanged.' },
  ], pending: [{ id: 'question', kind: 'question', title: 'Your input is needed', detail: '', questions: [{ id: 'scope', text: 'How should a zero limit behave?', options: ['Return an empty list', 'Use the default limit'] }] }] }
  await app.evaluate(({ BrowserWindow }, update) => { BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'dev:changed', update }) }, update)
  await expect(page.locator('.dev-message pre code')).toHaveText('return items.slice(0, limit)')
  await page.getByLabel('Return an empty list', { exact: true }).check()
  await expect(page.getByText('1,200 input · 240 output tokens')).toBeVisible()
  await screenshot('developers-task-light.png')
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark' })
  await screenshot('developers-task-dark.png')
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'light' })
}
test.afterAll(async () => { await app?.close() })
async function screenshot(file: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(tmp, file), Buffer.from(png, 'base64'))
}
test('developer workspace is opt-in, keeps normal chats separate and groups developer settings', async () => {
  await page.getByTestId('workspace-switcher').click()
  await page.getByTestId('activity-developers').click()
  await expect(page.getByRole('heading', { name: 'A workspace for your code' })).toBeVisible()
  await page.getByRole('button', { name: 'Enable Developers', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'What are we building?' })).toBeVisible()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).not.toHaveValue('')
  await page.getByRole('combobox', { name: 'Task access' }).selectOption('full-access')
  await expect(page.getByLabel('I allow commands and file changes without approval.')).not.toBeChecked()
  await page.getByRole('button', { name: 'Developer settings' }).click()
  await expect(page.getByTestId('settings-nav-developers')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('setting-session-watch')).not.toBeChecked()
  await expect(page.getByRole('heading', { name: 'Account usage' })).toBeVisible()
  await screenshot('developers-settings.png')
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: 'Task access' }).selectOption('review')
  const workspace = await page.getByTestId('developers-view').boundingBox(), canvas = await page.locator('.canvas').boundingBox()
  expect(workspace?.width).toBe(canvas?.width)
  await screenshot('developers-workspace.png')
  await page.setViewportSize({ width: 600, height: 850 })
  await expect(page.getByRole('textbox', { name: 'Development message' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await screenshot('developers-narrow.png')
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await expect(page.getByTestId('developers-view')).toHaveCount(0)
})
test('renders structured questions, code and task usage in light and dark layouts', renderTaskFixture)
