import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createBot, initVault } from 'core'
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
  await page.getByTestId('sidebar-search-toggle').focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Search conversations' })).toBeFocused()
  await page.keyboard.press('Escape'); await expect(page.getByTestId('sidebar-search-toggle')).toBeFocused()
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

test('a dialog above the sidebar takes the first Esc', async () => {
  await openByPointer()
  await page.keyboard.press('ControlOrMeta+Shift+P')
  const palette = page.getByTestId('palette-input')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expectOpen()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('a sidebar row menu takes the first Esc', async () => {
  await openByPointer()
  const trigger = page.getByTestId(`sidebar-chat-menu-${botId}`)
  await trigger.click()
  await expect(page.locator('.sidebar-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sidebar-menu')).toHaveCount(0)
  await expectOpen()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('the create popover takes the first Esc', async () => {
  await openByPointer()
  await page.getByTestId('sidebar-create').click()
  await expect(page.locator(':popover-open')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator(':popover-open')).toHaveCount(0)
  await expectOpen()
  await page.keyboard.press('Escape')
  await expectClosed()
})

test('IME composition Esc is ignored', async () => {
  await openByPointer()
  await page.getByTestId('sidebar-search-toggle').click(); await page.getByRole('textbox', { name: 'Search conversations' }).evaluate(input => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    const legacy = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(legacy, 'keyCode', { value: 229 })
    input.dispatchEvent(legacy)
  })
  await expectOpen()
  await page.keyboard.press('Escape'); await expectOpen()
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

test('Mission Control mini composers receive focus after dismissal', async () => {
  await openActivity(page, 'mission')
  await expect(page.locator('.mission-tile .mini-chat textarea').first()).toBeVisible()
  await page.setViewportSize(NARROW)
  await openByPointer()
  await page.keyboard.press('Escape')
  await expectClosed()
  const mini = page.locator('[data-testid^="mini-input-"]:focus')
  await typesInto(mini, 'mission')
  await openByPointer()
  await scrim().click({ position: { x: 700, y: 300 } })
  await expectClosed()
  await expect(page.locator('[data-testid^="mini-input-"]:focus')).toHaveCount(1)
  await screenshot('overlay-esc-mission.png')
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
