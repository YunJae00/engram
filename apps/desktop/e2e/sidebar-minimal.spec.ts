import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
let app: ElectronApplication | undefined
let page: Page
const dirs: string[] = []

function descent(name: Locator) {
  return name.evaluate(async node => {
    await document.fonts.ready
    const style = getComputedStyle(node), context = document.createElement('canvas').getContext('2d')!
    context.font = style.font
    const box = context.measureText(node.textContent ?? ''), ink = context.measureText('g')
    const contentHeight = box.fontBoundingBoxAscent + box.fontBoundingBoxDescent
    const lineHeight = style.lineHeight === 'normal' ? contentHeight : parseFloat(style.lineHeight)
    const bottom = parseFloat(style.paddingTop) + (lineHeight - contentHeight) / 2 + box.fontBoundingBoxAscent + ink.actualBoundingBoxDescent
    return { bottom, clientHeight: node.clientHeight, overflowX: style.overflowX, textOverflow: style.textOverflow, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
  })
}

test.describe.serial('minimal sidebar', () => {
  test.beforeAll(async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-sidebar-minimal-')), profile = await mkdtemp(join(TMP, 'e2e-sidebar-minimal-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('section headers show chevron, name and count without a folder icon', async () => {
    const heads = page.locator('.sidebar-folder-head .sidebar-item-main[aria-controls^="folder-"]')
    await expect(heads).toHaveCount(2)
    for (const head of await heads.all()) {
      await expect(head.locator('svg')).toHaveCount(1)
      await expect(head.locator('span').first()).toBeVisible()
      await expect(head.locator('small')).toHaveText(/^\d+$/)
    }
    await expect(heads.locator('span')).toHaveText(['Home', 'Money'])
    await page.getByTestId('sidebar-create').click()
    const newSection = page.locator('.sidebar-create-menu').getByRole('button', { name: 'New section' })
    await expect(newSection).toBeVisible()
    await expect(newSection.locator('svg')).toHaveCount(1)
    await newSection.click()
    const create = page.locator('.sidebar-folder-create')
    await expect(create.locator('input')).toBeFocused()
    await expect(create.locator('svg')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(create).toHaveCount(0)
    await expect(heads).toHaveCount(2)
  })

  test('the Engram wordmark keeps its descenders and still ellipsizes long names', async () => {
    const name = page.locator('.app-sidebar-head .workspace-name')
    await expect(name).toHaveText('Engram')
    const short = await descent(name)
    expect(short.bottom).toBeLessThanOrEqual(short.clientHeight + 0.5)
    await name.evaluate(node => { node.textContent = 'Pygmy jogging group '.repeat(3) })
    const long = await descent(name)
    expect(long.bottom).toBeLessThanOrEqual(long.clientHeight + 0.5)
    expect(long.textOverflow).toBe('ellipsis')
    expect(long.overflowX).toBe('hidden')
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth)
    const trigger = await page.locator('.app-sidebar-head .workspace-trigger').evaluate(node => node.getBoundingClientRect().height)
    expect(Math.abs(trigger - 32)).toBeLessThanOrEqual(1)
  })
})
