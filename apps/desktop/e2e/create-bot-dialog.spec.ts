import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { characterIndex, defaultCharacter, resolveCharacter } from '../../../packages/core/src/bot-character.js'
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
  test('dialog is 440 wide with radius 22 and a 64px preview in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await launch(theme)
      const dialog = await openDialog(page)
      const metrics = await dialog.evaluate(node => {
        const avatar = node.querySelector('[data-testid="create-bot-preview"] .bot-avatar')?.getBoundingClientRect()
        return { width: node.getBoundingClientRect().width, radius: getComputedStyle(node).borderTopLeftRadius, avatar: avatar && { width: avatar.width, height: avatar.height }, inShell: !!node.closest('[data-testid="shell"]') }
      })
      expect(Math.abs(metrics.width - 440)).toBeLessThanOrEqual(4)
      expect(metrics.radius).toBe('22px')
      expect(Math.abs((metrics.avatar?.width ?? 0) - 64)).toBeLessThanOrEqual(1)
      expect(Math.abs((metrics.avatar?.height ?? 0) - 64)).toBeLessThanOrEqual(1)
      expect(metrics.inShell).toBe(true)
      await closeTestApp(apps.pop())
    }
  })

  test('an unpicked Create gets the face of its real id, not the provisional preview, and opens an empty chat', async () => {
    const page = await launch('light', 'mock')
    const dialog = await openDialog(page)
    await expect(dialog.getByTestId('create-bot-preview')).toHaveAttribute('data-picked', 'false')
    const before = await bots(page)
    const ids = new Set(before.map(one => one.id))
    await dialog.getByTestId('create-bot-name').fill('Plain Bot')
    await dialog.getByTestId('create-bot-submit').click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await bots(page)).filter(one => !ids.has(one.id)).length).toBe(1)
    const created = (await bots(page)).find(one => !ids.has(one.id))!
    const prev = before.at(-1)!
    expect(created.name).toBe('Plain Bot')
    expect(created.avatar).toEqual({ character: defaultCharacter(created.id, characterIndex(resolveCharacter(prev.id, prev.avatar))) })
    expect(created.templateId).toBeFalsy()
    expect(created.label).toBeFalsy()
    await expect(page.locator('.bots-title-pill-name')).toHaveText('Plain Bot')
    await expect(page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar')).toHaveAttribute('data-character', (created.avatar as { character: string }).character)
    await page.waitForTimeout(1000)
    await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user')).toHaveCount(0)
  })

  test('an explicit pick in the 16-face picker is the stored face; no photo upload', async () => {
    const page = await launch('light')
    const dialog = await openDialog(page)
    await dialog.getByTestId('create-bot-avatar-change').click()
    const picker = dialog.getByTestId('avatar-picker')
    await expect(picker.getByRole('radio')).toHaveCount(16)
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0)
    await picker.getByRole('radio', { name: '10-comma', exact: true }).click()
    await expect(dialog.getByTestId('create-bot-preview')).toHaveAttribute('data-avatar', '10-comma')
    const ids = new Set((await bots(page)).map(one => one.id))
    await dialog.getByTestId('create-bot-name').fill('Picked Bot')
    await dialog.getByTestId('create-bot-submit').click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await bots(page)).find(one => !ids.has(one.id))?.avatar).toEqual({ character: '10-comma' })
  })

  test('first paint shows avatar and name only', async () => {
    const page = await launch('light')
    const dialog = await openDialog(page)
    for (const id of ['create-bot-preview', 'create-bot-avatar-change', 'create-bot-name', 'create-bot-submit']) await expect(dialog.getByTestId(id)).toBeVisible()
    await expect(dialog.getByTestId('create-bot-name')).toBeFocused()
    await expect(dialog.getByTestId('create-bot-submit')).toBeDisabled()
    for (const id of ['create-bot-task', 'create-bot-label', 'create-bot-more', 'create-bot-template']) await expect(dialog.getByTestId(id)).toHaveCount(0)
    await expect(dialog.locator('textarea, select, details')).toHaveCount(0)
    await expect(dialog.locator('input:not([type="file"])')).toHaveCount(1)
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0)
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
