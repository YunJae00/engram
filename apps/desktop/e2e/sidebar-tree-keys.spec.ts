import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'
import { contrastRatio, type Rgba } from './visual/spec.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')

async function launch(theme: 'light' | 'dark'): Promise<{ app: ElectronApplication; dirs: string[] }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'tree-keys-vault-')), profile = await mkdtemp(join(TMP, 'tree-keys-profile-'))
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  return { app, dirs: [vault, profile] }
}

async function prepare(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  return page
}

const focused = (page: Page) => page.evaluate(() => {
  const item = document.activeElement?.closest<HTMLElement>('.app-sidebar [role="tree"] [role="treeitem"]')
  return item && item === document.activeElement ? item.dataset['treeItem'] ?? '' : null
})

const rgba = (css: string): Rgba => {
  const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number)
  return [r, g, b, a]
}

async function ring(page: Page): Promise<{ width: string; style: string; offset: number; ratio: number | null }> {
  const read = await page.evaluate(() => {
    const item = document.activeElement as HTMLElement
    const box = item.matches('li') ? item : item.querySelector<HTMLElement>(':scope > .sidebar-folder-head')!
    const style = getComputedStyle(box), layers: string[] = []
    for (let el: Element | null = box; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor
      layers.push(bg)
      if (/^rgb\(/.test(bg)) break
    }
    return { width: style.outlineWidth, style: style.outlineStyle, offset: parseFloat(style.outlineOffset), color: style.outlineColor, layers }
  })
  return { ...read, ratio: contrastRatio(rgba(read.color), read.layers.map(rgba)) }
}

test('sidebar tree: one tab stop, arrows, F2, Shift+F10 and a 2px focus ring at 3:1 in light and dark', async () => {
  test.setTimeout(180_000)
  for (const theme of ['light', 'dark'] as const) {
    const { app, dirs } = await launch(theme)
    try {
      const page = await prepare(app)
      const item = (id: string) => page.locator(`.app-sidebar [role="tree"] [data-tree-item="${id}"]`)
      await expect(item('item:vis-new')).toBeVisible()

      await page.getByTestId('bot-vis-primary').focus()
      await page.keyboard.press('Tab')
      const stop = await focused(page)
      expect(stop, `${theme}: Tab from the hero reaches a treeitem`).toBeTruthy()
      expect(await page.locator('.app-sidebar [role="tree"] [role="treeitem"][tabindex="0"]').count()).toBe(1)
      expect(await page.locator('.app-sidebar [role="tree"] button:not([tabindex="-1"])').count(), 'inner buttons leave the tab order').toBe(0)
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('.app-sidebar [role="tree"]')), 'second Tab leaves the tree').toBe(false)
      await page.keyboard.press('Shift+Tab')
      expect(await focused(page)).toBe(stop)

      await item('item:vis-new').focus()
      await page.keyboard.press('Home')
      const first = await focused(page)
      await page.keyboard.press('ArrowUp')
      expect(await focused(page), 'no wrap at the top').toBe(first)
      await page.keyboard.press('ArrowDown')
      const second = await focused(page)
      expect(second).not.toBe(first)
      await page.keyboard.press('ArrowUp')
      expect(await focused(page)).toBe(first)
      await page.keyboard.press('End')
      expect(await focused(page)).toBe('hidden')

      const hiddenGroup = item('hidden')
      await expect(hiddenGroup).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Enter')
      await expect(hiddenGroup).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('ArrowRight')
      expect(await focused(page)).toBe('item:vis-hidden')
      await page.keyboard.press('ArrowLeft')
      expect(await focused(page)).toBe('hidden')
      await page.keyboard.press('ArrowLeft')
      await expect(hiddenGroup).toHaveAttribute('aria-expanded', 'false')

      const home = item('folder:vis-folder-home')
      await home.focus()
      await page.keyboard.press('ArrowLeft')
      await expect(home).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('ArrowRight')
      await expect(home).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('ArrowRight')
      expect(await focused(page)).toBe('item:vis-chat')
      const row = await ring(page)
      expect(row.width, `${theme}: bot row ring width`).toBe('2px')
      expect(row.style).toBe('solid')
      expect(row.offset).toBeLessThanOrEqual(-2)
      expect(row.ratio ?? 0, `${theme}: bot row ring contrast`).toBeGreaterThanOrEqual(3)
      await page.keyboard.press('ArrowLeft')
      expect(await focused(page)).toBe('folder:vis-folder-home')
      const head = await ring(page)
      expect(head.width, `${theme}: section ring width`).toBe('2px')
      expect(head.style).toBe('solid')
      expect(head.offset).toBeLessThanOrEqual(-2)
      expect(head.ratio ?? 0, `${theme}: section ring contrast`).toBeGreaterThanOrEqual(3)

      await page.keyboard.press('Shift+F10')
      await expect(page.getByRole('dialog', { name: 'Options for Home' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Options for Home' })).toHaveCount(0)
      expect(await focused(page)).toBe('folder:vis-folder-home')
      await page.keyboard.press('F2')
      await expect(page.locator('.app-sidebar [role="tree"] input')).toHaveValue('Home')
      await page.keyboard.press('Escape')
      await expect(page.locator('.app-sidebar [role="tree"] input')).toHaveCount(0)
      expect(await focused(page)).toBe('folder:vis-folder-home')
      await item('folder:vis-folder-home').locator(':scope > .sidebar-folder-head').click({ button: 'right' })
      await expect(page.getByRole('dialog', { name: 'Options for Home' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Options for Home' })).toHaveCount(0)
      expect(await focused(page)).toBe('folder:vis-folder-home')
      await item('item:vis-chat').click({ button: 'right' })
      await expect(page.getByRole('dialog', { name: 'Options for Garden planner' })).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'Options for Home' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      expect(await focused(page)).toBe('item:vis-chat')

      await item('item:vis-new').focus()
      await page.keyboard.press('F2')
      const rename = page.locator('.app-sidebar [role="tree"] input')
      await expect(rename).toBeFocused()
      await expect(rename).toHaveValue('New helper')
      await page.keyboard.press('Escape')
      await expect(rename).toHaveCount(0)
      expect(await focused(page)).toBe('item:vis-new')
      await expect(page.getByTestId('bot-vis-new')).toHaveText(/New helper/)

      const menu = page.getByRole('dialog', { name: 'Options for New helper' })
      for (const key of ['Shift+F10', 'ContextMenu']) {
        await page.keyboard.press(key)
        await expect(menu).toBeVisible()
        await page.keyboard.press('ArrowDown')
        expect(await focused(page), 'menu arrows do not move the tree').toBe(null)
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        expect(await focused(page)).toBe('item:vis-new')
      }
      await page.keyboard.press('Shift+F10')
      await expect(menu).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(menu).toHaveCount(0)
      expect(await focused(page), 'Tab closes the menu and keeps focus on its treeitem').toBe('item:vis-new')

      await page.keyboard.press('Enter')
      await expect(page.getByTestId('bot-vis-new')).toHaveClass(/active/)
    } finally {
      await closeTestApp(app)
      for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    }
  }
})
