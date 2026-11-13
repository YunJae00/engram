import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault, CHAT_ID } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const apps: ElectronApplication[] = []
const dirs: string[] = []

async function launch(theme: 'light' | 'dark'): Promise<Page> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-avatar-picker-')), profile = await mkdtemp(join(TMP, 'e2e-avatar-picker-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme, uiLanguage: 'en' }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
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

async function openPicker(page: Page): Promise<Locator> {
  await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
  await page.getByTestId('bots-new').click()
  const dialog = page.locator('[role="dialog"][data-testid="create-bot-dialog"]')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('create-bot-avatar-change').click()
  const picker = dialog.getByTestId('avatar-picker')
  await expect(picker).toBeVisible()
  return picker
}

const ringOf = (cell: Locator) => cell.evaluate(node => { const s = getComputedStyle(node); return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor } })
const avatarOf = (page: Page, id: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.avatar ?? null, id)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('avatar picker', () => {
  test('picker geometry: 80 preview, a 4x4 grid of 56px cells, and a 2px ink ring, never blue', async () => {
    const page = await launch('light')
    const picker = await openPicker(page)
    await expect(picker.locator('[aria-checked="true"]')).toHaveCount(0)
    await picker.getByRole('radio', { name: '05-squircle', exact: true }).click()
    const m = await picker.evaluate(node => {
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: Math.round(r.left), top: Math.round(r.top) } }
      return { preview: box(node.closest('dialog')!.querySelector('[data-testid="create-bot-preview"] .bot-avatar')!), cells: [...node.querySelectorAll('.avatar-picker-cell')].map(box) }
    })
    expect(Math.abs(m.preview.width - 80)).toBeLessThanOrEqual(1)
    expect(m.cells.length).toBe(16)
    for (const cell of m.cells) { expect(Math.abs(cell.width - 56)).toBeLessThanOrEqual(1); expect(Math.abs(cell.height - 56)).toBeLessThanOrEqual(1) }
    expect(new Set(m.cells.map(c => c.left)).size).toBe(4)
    expect(new Set(m.cells.map(c => c.top)).size).toBe(4)
    const checked = picker.locator('[aria-checked="true"]')
    await expect(checked).toHaveCount(1)
    expect(await ringOf(checked)).toEqual({ width: '2px', style: 'solid', color: 'rgb(28, 28, 30)' })
    await expect(page.getByTestId('create-bot-preview')).toHaveAttribute('data-avatar', '05-squircle')
  })

  test('info pane: the avatar opens the picker, a pick is saved as a character, Default saves the id face', async () => {
    const page = await launch('light')
    await page.getByTestId(`bot-${CHAT_ID}`).click()
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await expect(page.getByTestId('bot-info-pane')).toBeVisible()
    await expect(page.getByTestId('bot-info-pane').getByRole('tab')).toHaveCount(0)
    await page.getByTestId('bot-info-avatar').click()
    const picker = page.locator('#bot-info-avatar-picker [data-testid="avatar-picker"]')
    await expect(picker).toBeVisible()
    expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await picker.getByRole('radio', { name: '12-crescent', exact: true }).click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toEqual({ character: '12-crescent' })
    await picker.getByRole('radio', { name: '03-cashew', exact: true }).click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toEqual({ character: '03-cashew' })
    await picker.getByTestId('avatar-picker-default').click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toEqual({ character: expect.stringMatching(/^\d\d-[a-z-]+$/) })
    await expect.poll(() => page.evaluate(id => window.engram.botAvatarImage(id), CHAT_ID)).toBeNull()
  })

  test('arrow keys move ±1 and ±4 in the grid and Tab leaves it', async () => {
    const page = await launch('light')
    const picker = await openPicker(page)
    const grid = picker.getByRole('radiogroup')
    const radios = grid.getByRole('radio')
    await expect(radios).toHaveCount(16)
    await grid.locator('[tabindex="0"]').focus()
    await page.keyboard.press('Home')
    const focusedIndex = () => grid.evaluate(node => [...node.querySelectorAll('[role="radio"]')].indexOf(document.activeElement as Element))
    const checkedIndex = () => radios.evaluateAll(cells => cells.findIndex(cell => cell.getAttribute('aria-checked') === 'true'))
    await expect.poll(checkedIndex).toBe(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedIndex).toBe(1)
    await page.keyboard.press('ArrowDown')
    await expect.poll(focusedIndex).toBe(5)
    await expect.poll(checkedIndex).toBe(5)
    await page.keyboard.press('End')
    await expect.poll(checkedIndex).toBe(15)
    expect((await ringOf(radios.nth(15))).color).toBe('rgb(28, 28, 30)')
    await page.keyboard.press('Tab')
    expect(await grid.evaluate(node => node.contains(document.activeElement))).toBe(false)
  })

  test('the avatar picker has no photo upload', async () => {
    const page = await launch('light')
    const noUpload = async (scope: Locator) => {
      await expect(scope.getByRole('tab')).toHaveCount(0)
      await expect(scope.locator('input[type="file"]')).toHaveCount(0)
      await expect(scope.getByTestId('avatar-picker-file')).toHaveCount(0)
      await expect(scope.getByText('PNG', { exact: false })).toHaveCount(0)
    }
    const picker = await openPicker(page)
    await expect(picker.getByTestId('avatar-picker-default')).toBeVisible()
    await noUpload(page.getByTestId('create-bot-dialog'))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)
    await page.getByTestId(`bot-${CHAT_ID}`).click()
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await page.getByTestId('bot-info-avatar').click()
    const pane = page.locator('#bot-info-avatar-picker')
    await expect(pane.getByTestId('avatar-picker')).toBeVisible()
    await noUpload(pane)
    await expect(page.evaluate(id => window.engram.botAvatarSet(id, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), CHAT_ID)).rejects.toThrow(/no longer supported/)
  })

  test('one avatar preview while the picker is open', async () => {
    const page = await launch('light')
    const large = (scope: Locator) => scope.evaluate(node => [...node.querySelectorAll('.bot-avatar')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width >= 64 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) })
      .map(el => el.getAttribute('data-character')))
    const check = async (scope: Locator, picker: Locator, where: string) => {
      const before = await large(scope)
      expect(before.length, `ONE-PREVIEW ${where}`).toBe(1)
      await picker.locator('[role="radio"]:not([data-character="' + before[0] + '"])').first().click()
      await expect.poll(() => large(scope), { message: `ONE-PREVIEW ${where}: the preview does not update on pick` }).not.toEqual(before)
      expect((await large(scope)).length).toBe(1)
    }
    const picker = await openPicker(page)
    await check(page.getByTestId('create-bot-dialog'), picker, 'new-bot-dialog')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)
    await page.getByTestId(`bot-${CHAT_ID}`).click()
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await page.getByTestId('bot-info-avatar').click()
    const pane = page.getByTestId('bot-info-pane')
    await expect(pane.getByTestId('avatar-picker')).toBeVisible()
    await check(pane, pane.getByTestId('avatar-picker'), 'details-pane')
  })
})
