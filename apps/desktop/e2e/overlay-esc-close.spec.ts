import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, project: string, botId: string
const seats: string[] = []
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const NARROW = { width: 780, height: 720 }, WIDE = { width: 1280, height: 900 }

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-overlay-esc-vault-'))
  project = await mkdtemp(join(tmp, 'e2e-overlay-esc-project-'))
  await writeFile(join(project, 'example.ts'), 'export const answer = 42\n')
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths) // a v2 list keeps the seeded bots through launch
  for (const name of ['Overlay chat', 'Second chat', 'Third chat', 'Fourth chat']) seats.push((await createBot(paths, { name })).id)
  botId = seats[0]!
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-overlay-esc-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_DEVELOPER_FIXTURE: '1' } })
  page = await app.firstWindow()
  await page.evaluate(ids => { localStorage.setItem('engram.tour.done', '1'); localStorage.setItem('engram.mission.slots', JSON.stringify(ids)) }, seats)
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize(NARROW)
})
test.afterAll(async () => { await closeTestApp(app) })

async function screenshot(file: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(tmp, file), Buffer.from(png, 'base64'))
}
const sidebar = () => page.getByTestId('app-sidebar')
const scrim = () => page.locator('.sidebar-scrim')
const composer = () => page.locator('[data-testid="bots-input"], [data-testid="welcome-input"]').first()
async function expectOpen() { await expect(sidebar()).toHaveAttribute('aria-hidden', 'false') }
async function expectClosed() { await expect(sidebar()).toHaveAttribute('aria-hidden', 'true'); await expect(scrim()).toHaveCount(0) }
async function openByPointer() {
  if (await sidebar().getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expectOpen()
}
async function typesInto(field: Locator, text: string) {
  await expect(field).toBeFocused()
  await page.keyboard.type(text)
  await expect(field).toHaveValue(new RegExp(`${text}$`))
}

test('keyboard open, Esc closes and typing lands in the composer', async () => {
  if (await sidebar().getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
  await expectClosed()
  await page.keyboard.press('ControlOrMeta+B')
  await expectOpen()
  await screenshot('overlay-esc-before.png')
  // The sidebar has no search field to take an Esc first.
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Search conversations' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectClosed()
  await typesInto(composer(), 'hello')
  await screenshot('overlay-esc-after.png')
})

test('pointer open and scrim click return focus to the composer', async () => {
  await openByPointer()
  await scrim().click({ position: { x: 700, y: 300 } })
  await expectClosed()
  await typesInto(composer(), 'pointer')
})

test('pointer open then Esc closes', async () => {
  await openByPointer()
  await page.keyboard.press('Escape')
  await expectClosed()
  await typesInto(composer(), 'esc')
})

test('the old palette shortcut opens nothing, and the new-bot dialog above the sidebar takes the first Esc', async () => {
  await openByPointer()
  await page.keyboard.press('ControlOrMeta+Shift+P')
  await expect(page.getByTestId('palette-input')).toHaveCount(0)
  await expectOpen()
  await page.getByTestId('sidebar-create').click()
  const dialog = page.getByTestId('create-bot-dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expectOpen()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('right-clicking a sidebar row opens no menu, and Esc closes the sidebar', async () => {
  await openByPointer()
  const trigger = page.getByTestId(`bot-${botId}`)
  await trigger.click({ button: 'right' })
  await expect(page.locator('.sidebar-menu')).toHaveCount(0)
  await expectOpen()
  // The row is still a plain way into its chat.
  await expect(trigger).toBeVisible()
  await page.keyboard.press('Escape')
  await expectClosed()
  await typesInto(composer(), 'row')
})

test('right-clicking empty sidebar space opens no create menu, and Esc closes the sidebar', async () => {
  await openByPointer()
  const scroll = page.locator('.sidebar-scroll')
  const box = (await scroll.boundingBox())!
  await scroll.click({ button: 'right', position: { x: 20, y: box.height - 4 } })
  await expect(page.getByTestId('sidebar-space-new-folder')).toHaveCount(0)
  await expect(page.locator('.sidebar-menu')).toHaveCount(0)
  await expectOpen()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('IME composition Esc is ignored', async () => {
  await openByPointer()
  // The search field is gone; the composing Esc is sent from the sidebar's "+" button instead.
  await page.getByTestId('sidebar-create').evaluate(input => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    const legacy = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(legacy, 'keyCode', { value: 229 })
    input.dispatchEvent(legacy)
  })
  await expectOpen()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('a focused field outside the sidebar keeps its own Esc', async () => {
  await page.evaluate(() => {
    const field = document.createElement('input')
    field.dataset.testid = 'esc-owner'
    field.addEventListener('keydown', event => { if (event.key === 'Escape') field.value = 'cancelled' })
    document.querySelector('.canvas-slot:not([hidden])')!.prepend(field)
    field.focus()
  })
  await page.keyboard.press('ControlOrMeta+B')
  await expectOpen()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('esc-owner')).toHaveValue('cancelled')
  await expectOpen()
  await page.getByTestId('esc-owner').evaluate(field => field.remove())
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('wide window and a resize while open keep the sidebar', async () => {
  await page.setViewportSize(WIDE)
  await openByPointer()
  await page.keyboard.press('Escape')
  await expectOpen()
  await expect(page.getByTestId('shell')).toHaveClass(/sidebar-open/)
  await screenshot('overlay-esc-wide.png')
  await page.setViewportSize(NARROW)
  await expectOpen()
  await page.setViewportSize(WIDE)
  await page.keyboard.press('Escape')
  await expectOpen()
})

test('the single chat composer receives focus after dismissal', async () => {
  await openActivity(page, 'bots')
  await expect(page.locator('.mission-tile')).toHaveCount(0)
  await page.setViewportSize(NARROW)
  await openByPointer()
  await page.getByTestId(`bot-${botId}`).click()
  const input = page.getByTestId('bots-input')
  await expect(input).toBeVisible()
  if (await sidebar().getAttribute('aria-hidden') === 'true') await openByPointer()
  await page.keyboard.press('Escape')
  await expectClosed()
  await typesInto(input, 'single')
  await openByPointer()
  await scrim().click({ position: { x: 700, y: 300 } })
  await expectClosed()
  await expect(input).toBeFocused()
  await screenshot('overlay-esc-single.png')
})

test('the Development message composer receives focus after dismissal', async () => {
  await page.setViewportSize(WIDE)
  await openByPointer()
  await page.getByRole('button', { name: 'Developers mode', exact: true }).click()
  await page.getByRole('button', { name: 'Enable Developers', exact: true }).click()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await page.getByRole('button', { name: 'Add folder', exact: true }).click()
  const message = page.getByRole('textbox', { name: 'Development message' })
  await expect(message).toBeEnabled()
  await page.setViewportSize(NARROW)
  await openByPointer()
  await page.keyboard.press('Escape')
  await expectClosed()
  await typesInto(message, 'devtext')
  await screenshot('overlay-esc-developers.png')
})
