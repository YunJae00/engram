import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const DRAFT = 'Unsent draft that must survive the language switch'

type Overflow = { key: string; ellipsized: boolean }
type Layout = { widths: number[]; overflow: Overflow[] }

async function launch(): Promise<{ app: ElectronApplication; chatId: string; profile: string; dirs: string[] }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'i18n-settings-vault-')), profile = await mkdtemp(join(TMP, 'i18n-settings-profile-'))
  const { chatId } = await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  return { app, chatId, profile, dirs: [vault, profile] }
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

async function openChat(page: Page, chatId: string): Promise<void> {
  const row = page.getByTestId(`bot-${chatId}`)
  const earlier = page.getByTestId('sidebar-earlier')
  if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
  await row.click()
  await expect(page.locator('[data-testid="bots-input"]')).toBeVisible()
}

async function openSettings(page: Page): Promise<void> {
  if (!await page.getByTestId('settings-view').isVisible()) await page.getByTestId('activity-settings').click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
}

async function savedLanguage(profile: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).uiLanguage } catch { return undefined }
}

async function layout(page: Page): Promise<Layout> {
  await openSettings(page)
  const widths: number[] = [], overflow: Overflow[] = []
  const ids = await page.locator('[data-testid^="settings-nav-"]').evaluateAll(nodes => nodes
    .filter(node => (node as HTMLElement).checkVisibility()).map(node => node.getAttribute('data-testid')!))
  for (const id of ids) {
    await page.getByTestId(id).click()
    await expect(page.getByTestId(id)).toHaveAttribute('aria-current', 'page')
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    widths.push(await page.getByTestId('settings-view').evaluate(node => node.getBoundingClientRect().width))
    overflow.push(...await page.getByTestId('settings-view').evaluate(root => [...root.querySelectorAll<HTMLElement>('*')]
      .filter(el => el.checkVisibility({ checkVisibilityCSS: true }) && el.scrollWidth > el.clientWidth)
      .map(el => {
        const cs = getComputedStyle(el)
        return { key: `${el.tagName}.${[...el.classList].sort().join('.')}`, ellipsized: cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' }
      })))
  }
  return { widths, overflow }
}

async function pick(page: Page, language: 'system' | 'ko' | 'en'): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-nav-general').click()
  await page.getByTestId(`setting-ui-language-${language}`).click()
}

test('Settings language picker switches the UI live, keeps the draft and the Korean layout', async () => {
  const { app, chatId, profile, dirs } = await launch()
  try {
    const page = await prepare(app)
    await openChat(page, chatId)
    await page.locator('[data-testid="bots-input"]').fill(DRAFT)
    await page.evaluate(() => { (window as unknown as { __langMarker: number }).__langMarker = 1 })

    await pick(page, 'ko')
    await expect(page.getByTestId('activity-settings')).toHaveAttribute('aria-label', '설정')
    expect(await page.evaluate(() => (window as unknown as { __langMarker?: number }).__langMarker)).toBe(1)
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
    await expect.poll(() => savedLanguage(profile)).toBe('ko')
    const ko = await layout(page)

    await pick(page, 'en')
    await expect(page.getByTestId('activity-settings')).toHaveAttribute('aria-label', 'Settings')
    await expect.poll(() => savedLanguage(profile)).toBe('en')
    const en = await layout(page)

    expect(ko.widths.length).toBeGreaterThanOrEqual(4)
    expect(ko.widths.length).toBe(en.widths.length)
    ko.widths.forEach((width, index) => expect(Math.abs(width - en.widths[index]!), `section ${index} width`).toBeLessThanOrEqual(2))
    const enKeys = new Set(en.overflow.map(one => one.key))
    expect(ko.overflow.filter(one => !one.ellipsized && !enKeys.has(one.key)), 'new Korean settings overflow').toEqual([])

    if (await page.getByTestId('settings-view').isVisible()) await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('settings-view')).toBeHidden()
    await openChat(page, chatId)
    await expect(page.locator('[data-testid="bots-input"]')).toHaveValue(DRAFT)

    await pick(page, 'system')
    await expect.poll(() => savedLanguage(profile)).toBe('system')
    expect(await page.evaluate(() => (window as unknown as { __langMarker?: number }).__langMarker)).toBe(1)
  } finally {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  }
})
