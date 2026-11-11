import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const apps: ElectronApplication[] = []
const dirs: string[] = []

async function launch(theme: 'light' | 'dark', engine = 'none'): Promise<Page> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-create-bot-')), profile = await mkdtemp(join(TMP, 'e2e-create-bot-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme, uiLanguage: 'en' }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: engine, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  apps.push(app)
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  return page
}

async function openDialog(page: Page) {
  await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
  await page.getByTestId('bots-new').click()
  const dialog = page.locator('[role="dialog"][data-testid="create-bot-dialog"]')
  await expect(dialog).toBeVisible()
  return dialog
}

const bots = (page: Page) => page.evaluate(() => window.engram.botsList())

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('create bot dialog', () => {
  test('dialog is 440 wide with radius 22 and a 96px preview in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await launch(theme)
      const dialog = await openDialog(page)
      const metrics = await dialog.evaluate(node => {
        const avatar = node.querySelector('[data-testid="create-bot-preview"] .bot-avatar')?.getBoundingClientRect()
        return { width: node.getBoundingClientRect().width, radius: getComputedStyle(node).borderTopLeftRadius, avatar: avatar && { width: avatar.width, height: avatar.height }, inShell: !!node.closest('[data-testid="shell"]') }
      })
      expect(Math.abs(metrics.width - 440)).toBeLessThanOrEqual(4)
      expect(metrics.radius).toBe('22px')
      expect(Math.abs((metrics.avatar?.width ?? 0) - 96)).toBeLessThanOrEqual(1)
      expect(Math.abs((metrics.avatar?.height ?? 0) - 96)).toBeLessThanOrEqual(1)
      expect(metrics.inShell).toBe(true)
      await closeTestApp(apps.pop())
    }
  })

  test('template prefill and Create keep the previewed character', async () => {
    const page = await launch('light')
    const dialog = await openDialog(page)
    const research = (await page.evaluate(() => window.engram.botTemplates())).find(template => template.id === 'research')
    expect(research).toBeTruthy()
    const preview = dialog.getByTestId('create-bot-preview')
    const before = (await preview.getAttribute('data-avatar'))!.split('-').map(Number)
    await expect(dialog.locator('[data-testid="create-bot-template"] option[value="research"]')).toHaveCount(1)
    await dialog.getByTestId('create-bot-template').selectOption('research')
    await expect(dialog.getByTestId('create-bot-name')).toHaveValue(research!.name)
    await expect(dialog.getByTestId('create-bot-label')).toHaveValue(research!.label ?? '')
    await expect(preview).toHaveAttribute('data-avatar', `${before[0]}-${before[1]}-4-${before[3]}`)
    const [body, face, accessory, palette] = (await preview.getAttribute('data-avatar'))!.split('-').map(Number)
    const ids = new Set((await bots(page)).map(one => one.id))
    await dialog.getByTestId('create-bot-submit').click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await bots(page)).filter(one => !ids.has(one.id)).length).toBe(1)
    const created = (await bots(page)).find(one => !ids.has(one.id))!
    expect(created.templateId).toBe('research')
    expect(created.purpose).toBe(research!.purpose)
    expect(created.label).toBe(research!.label)
    expect(created.avatar).toEqual({ body, face, accessory, palette })
  })

  test('first task is sent to the new bot', async () => {
    const page = await launch('light', 'mock')
    const dialog = await openDialog(page)
    await dialog.getByTestId('create-bot-name').fill('Task Bot')
    await dialog.getByTestId('create-bot-task').fill('zq first task')
    await dialog.getByTestId('create-bot-submit').click()
    await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user')).toContainText(['zq first task'], { timeout: 10_000 })
    await expect(page.locator('.bots-title-pill-name')).toHaveText('Task Bot')
  })

  test('Escape closes only the dialog and creates nothing', async () => {
    const page = await launch('light')
    const count = (await bots(page)).length
    const dialog = await openDialog(page)
    await dialog.getByTestId('create-bot-name').fill('Not made')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    expect((await bots(page)).length).toBe(count)
    await expect(page.getByTestId('comet-welcome')).toBeVisible()
  })
})
