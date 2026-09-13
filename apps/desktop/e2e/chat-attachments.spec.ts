import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.describe.configure({ mode: 'serial' })
const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let paths: VaultPaths
let input: string

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-attachments-'))
  paths = await initVault(root, { git: false })
  input = join(root, 'request.txt')
  await writeFile(input, 'The delivery date is September 22. Please use this attached reference.')
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-attachments-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1',
    ENGRAM_MOCK_DIR: fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url)),
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
})
test.afterAll(async () => { await app?.close() })

test('native picker attaches a file to a new chat without importing it into Cosmos', async () => {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await (await chooser).setFiles(input)
  await expect(page.getByLabel('Attached files')).toContainText('request.txt')
  await expect(page.getByTestId('welcome-input-send')).toBeEnabled()
  await page.getByTestId('welcome-input-send').click()
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect(page.locator('.bots-view .bubble-msg.user').last()).toHaveText('Attached: request.txt')
  await expect(page.locator('.bots-view .bubble-msg.assistant').last()).toContainText('Record this if you want it kept')
  const first = (await page.evaluate(() => window.engram.botsList()))[0]!
  const turns = await page.evaluate(id => window.engram.botTranscript(id), first.id)
  expect(turns.filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual(['Attached: request.txt'])
  expect(await readdir(paths.inbox)).toEqual([])
  expect(await readdir(paths.sources)).toEqual([])
  expect(await readdir(paths.notes)).toEqual([])
  expect(await readdir(join(paths.cache, 'chat-attachments'))).toHaveLength(1)
})

test('keeps pending attachments in their chat, removes them, and accepts drop and paste', async () => {
  const first = (await page.evaluate(() => window.engram.botsList()))[0]!
  const second = await page.evaluate(() => window.engram.botCreate({ name: 'Separate attachment chat', purpose: '' }))
  await page.getByTestId('bots-input-files').setInputFiles(input)
  await expect(page.getByLabel('Attached files')).toContainText('request.txt')
  await page.getByTestId(`bot-${second.id}`).click()
  await expect(page.getByLabel('Attached files')).toHaveCount(0)
  await page.getByTestId(`bot-${first.id}`).click()
  await expect(page.getByLabel('Attached files')).toContainText('request.txt')
  await page.getByRole('button', { name: 'Remove request.txt', exact: true }).click()
  await expect(page.getByLabel('Attached files')).toHaveCount(0)
  await page.getByTestId('bots-input').evaluate(node => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Dropped file evidence'], 'dropped.txt', { type: 'text/plain' }))
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(page.getByLabel('Attached files')).toContainText('dropped.txt')
  await page.getByTestId('bots-input').evaluate(node => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Pasted file evidence'], 'pasted.txt', { type: 'text/plain' }))
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await expect(page.getByLabel('Attached files')).toContainText('pasted.txt')
  await page.getByTestId('bots-input').fill('Compare the attached files.')
  await page.getByTestId('bots-input').press('Enter')
  await expect(page.getByTestId('bots-input')).toHaveValue('')
  await expect(page.locator('.bots-view .bubble-msg.user').last()).toHaveText('Compare the attached files.\n\nAttached: dropped.txt, pasted.txt')
  await expect(page.locator('.bots-view .bubble-msg.assistant').last()).toContainText('Record this if you want it kept')
  expect(await readdir(paths.inbox)).toEqual([])
  expect(await readdir(paths.notes)).toEqual([])
})

test('rejects unsupported inputs visibly and accepts an image', async () => {
  await page.getByTestId('bots-input-files').setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not allowed') })
  await expect(page.getByRole('alert')).toContainText('Attach text, PDF, Office documents')
  await expect(page.getByLabel('Attached files')).toHaveCount(0)
  const pixel = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG().toString('base64'))
  await page.getByTestId('bots-input-files').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') })
  await expect(page.getByLabel('Attached files')).toContainText('pixel.png')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('bots-input-send')).toBeEnabled()
})
