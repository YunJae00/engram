import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { contrastRatio, type Rgba } from './visual/spec.js'
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

const avatarOf = (page: Page, id: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.avatar ?? null, id)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('avatar picker', () => {
  test('picker geometry: 96 preview, 40 cells, 24 swatches and a 2px ring with 3:1 contrast in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await launch(theme)
      const picker = await openPicker(page)
      const m = await picker.evaluate(node => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height } }
        const parse = (text: string) => (text.match(/[\d.]+/g) ?? []).map(Number)
        const rings = [...node.querySelectorAll('.avatar-picker-cell[aria-checked="true"]')].map(cell => {
          const style = getComputedStyle(cell)
          let bg: number[] = []
          for (let el: Element | null = cell; el; el = el.parentElement) {
            const c = parse(getComputedStyle(el).backgroundColor)
            if (c.length === 3 || (c.length === 4 && c[3] === 1)) { bg = c; break }
          }
          return { width: style.outlineWidth, style: style.outlineStyle, color: parse(style.outlineColor), bg }
        })
        return {
          preview: box(node.closest('dialog')!.querySelector('[data-testid="create-bot-preview"] .bot-avatar')!),
          cells: [...node.querySelectorAll('.avatar-picker-cell')].map(box),
          swatches: [...node.querySelectorAll('.avatar-picker-swatch')].map(box),
          rings,
        }
      })
      expect(Math.abs(m.preview.width - 96)).toBeLessThanOrEqual(1)
      expect(Math.abs(m.preview.height - 96)).toBeLessThanOrEqual(1)
      expect(m.cells.length).toBe(6 + 6 + 9 + 8)
      for (const cell of m.cells) { expect(Math.abs(cell.width - 40)).toBeLessThanOrEqual(1); expect(Math.abs(cell.height - 40)).toBeLessThanOrEqual(1) }
      expect(m.swatches.length).toBe(8)
      for (const swatch of m.swatches) { expect(Math.abs(swatch.width - 24)).toBeLessThanOrEqual(1); expect(Math.abs(swatch.height - 24)).toBeLessThanOrEqual(1) }
      expect(m.rings.length).toBe(4)
      for (const ring of m.rings) {
        expect(ring.width).toBe('2px')
        expect(ring.style).toBe('solid')
        const rgba = (c: number[]): Rgba => [c[0]!, c[1]!, c[2]!, c[3] ?? 1]
        expect(contrastRatio(rgba(ring.color), [rgba(ring.bg)])).toBeGreaterThanOrEqual(3)
      }
      while (apps.length) await closeTestApp(apps.pop())
    }
  })

  test('info pane: the avatar opens the picker, a pick is saved, Default clears it, and the accessory row wraps to two lines', async () => {
    const page = await launch('light')
    await page.getByTestId(`bot-${CHAT_ID}`).click()
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await expect(page.getByTestId('bot-info-pane')).toBeVisible()
    await page.getByTestId('bot-info-avatar').click()
    const picker = page.locator('#bot-info-avatar-picker [data-testid="avatar-picker"]')
    await expect(picker).toBeVisible()
    const layout = await picker.evaluate(node => ({
      tops: new Set([...node.querySelectorAll<HTMLElement>('[data-part="accessory"] .avatar-picker-cell')].map(cell => cell.offsetTop)).size,
      fits: node.scrollWidth <= node.clientWidth,
    }))
    expect(layout).toEqual({ tops: 2, fits: true })
    const face = picker.locator('[data-part="face"]')
    await face.getByRole('radio', { name: 'Face 3', exact: true }).click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toMatchObject({ face: 2 })
    const saved = await avatarOf(page, CHAT_ID) as Record<string, unknown>
    expect(Object.keys(saved).sort()).toEqual(['accessory', 'body', 'face', 'palette'])
    for (const value of Object.values(saved)) expect(Number.isInteger(value)).toBe(true)
    await face.getByRole('radio', { name: 'Face 4', exact: true }).click()
    await picker.locator('[data-part="palette"]').getByRole('radio', { name: 'Pink', exact: true }).click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toMatchObject({ face: 3, palette: 1 })
    await picker.getByTestId('avatar-picker-default').click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toBeNull()
    await expect.poll(() => page.evaluate(id => window.engram.botAvatarImage(id), CHAT_ID)).toBeNull()
    await face.getByRole('radio', { name: 'Face 2', exact: true }).click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toMatchObject({ face: 1 })
    await picker.getByTestId('avatar-picker-default').click()
    await expect.poll(() => avatarOf(page, CHAT_ID)).toBeNull()
  })

  test('arrow keys move the checked cell within a row and Tab leaves the row', async () => {
    const page = await launch('light')
    const picker = await openPicker(page)
    const row = picker.locator('[data-part="face"]')
    const radios = row.getByRole('radio')
    await row.locator('[aria-checked="true"]').focus()
    const start = await radios.evaluateAll(cells => cells.findIndex(cell => cell.getAttribute('aria-checked') === 'true'))
    const focusedIndex = () => row.evaluate(node => [...node.querySelectorAll('[role="radio"]')].indexOf(document.activeElement as Element))
    const checkedIndex = () => radios.evaluateAll(cells => cells.findIndex(cell => cell.getAttribute('aria-checked') === 'true'))
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedIndex).toBe((start + 1) % 6)
    await expect.poll(checkedIndex).toBe((start + 1) % 6)
    await page.keyboard.press('End')
    await expect.poll(focusedIndex).toBe(5)
    await expect.poll(checkedIndex).toBe(5)
    await page.keyboard.press('Home')
    await expect.poll(focusedIndex).toBe(0)
    await expect.poll(checkedIndex).toBe(0)
    await page.keyboard.press('Tab')
    expect(await row.evaluate(node => node.contains(document.activeElement))).toBe(false)
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
    await expect(picker.getByTestId('avatar-picker-random')).toBeVisible()
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
  })

  test('one avatar preview while the picker is open', async () => {
    const page = await launch('light')
    const app = apps.at(-1)!
    const large = (scope: Locator) => scope.evaluate(node => [...node.querySelectorAll('.bot-avatar')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width >= 64 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) })
      .map(el => el.outerHTML))
    const shot = async (name: string) => {
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
      await test.info().attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    }
    const pickOtherBody = async (picker: Locator) => {
      await picker.locator('[data-part="body"] [role="radio"][aria-checked="false"]').first().click()
    }
    const check = async (scope: Locator, picker: Locator, where: string) => {
      const before = await large(scope)
      expect(before.length, `ONE-PREVIEW ${where}: ${before.length} large avatars while the picker is open`).toBe(1)
      await pickOtherBody(picker)
      await expect.poll(() => large(scope), { message: `ONE-PREVIEW ${where}: the preview does not update on pick` }).not.toEqual(before)
      const after = await large(scope)
      expect(after.length, `ONE-PREVIEW ${where}: ${after.length} large avatars after a pick`).toBe(1)
      await shot(`${where}.png`)
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
