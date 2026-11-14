import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const THEMES = ['light', 'dark'] as const
interface Overflow { key: string; ellipsized: boolean }
interface Measured { pane: number; dialog: number; overflow: Overflow[] }

const overflowUnder = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="bots-view"] *, [data-testid="create-bot-dialog"] *')]
  .filter(el => el.checkVisibility({ checkVisibilityCSS: true }) && el.scrollWidth > el.clientWidth)
  .map(el => {
    const cs = getComputedStyle(el)
    return { key: `${el.tagName}.${[...el.classList].sort().join('.')}`, ellipsized: cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' }
  }))

async function measure(theme: typeof THEMES[number], lang: 'en' | 'ko'): Promise<Measured> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'i18n-bot-vault-')), profile = await mkdtemp(join(TMP, 'i18n-bot-profile-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const { chatId } = await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme, uiLanguage: lang }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('activity-settings')).toHaveAttribute('aria-label', lang === 'en' ? 'Settings' : '설정')
    const row = page.getByTestId(`bot-${chatId}`)
    const earlier = page.getByTestId('sidebar-earlier')
    if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
    await row.click()
    const view = page.getByTestId('bots-view')
    await expect(view.locator('.bubble-msg.user').first()).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const overflow: Overflow[] = []

    await expect(view.getByTestId('model-picker')).toHaveCount(0)

    await view.getByTestId('bots-title-pill').click()
    const pane = page.getByTestId('bot-info-pane')
    await expect(pane).toBeVisible()
    const tabs = pane.getByRole('tab')
    await expect(tabs).toHaveCount(5)
    for (let i = 0; i < 5; i++) {
      await tabs.nth(i).click()
      overflow.push(...await overflowUnder(page))
    }
    const paneWidth = (await pane.boundingBox())?.width ?? 0
    await page.keyboard.press('Escape')
    await expect(pane).toBeHidden()

    await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
    await page.getByTestId('bots-new').first().click()
    const dialog = page.getByTestId('create-bot-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-bot-avatar-change').click()
    await expect(dialog.getByTestId('create-bot-avatar-change')).toHaveAttribute('aria-expanded', 'true')
    overflow.push(...await overflowUnder(page))
    const dialogWidth = (await dialog.boundingBox())?.width ?? 0
    return { pane: paneWidth, dialog: dialogWidth, overflow }
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
  }
}

test('Korean bot surfaces keep the layout: info pane 320, dialog 440, no new overflow', async () => {
  test.setTimeout(300_000)
  for (const theme of THEMES) {
    const en = await measure(theme, 'en')
    const ko = await measure(theme, 'ko')
    expect(Math.abs(ko.pane - 320), `${theme} info pane width ${ko.pane}`).toBeLessThanOrEqual(2)
    expect(Math.abs(ko.dialog - 440), `${theme} dialog width ${ko.dialog}`).toBeLessThanOrEqual(4)
    const enKeys = new Set(en.overflow.map(one => one.key))
    const fresh = ko.overflow.filter(one => !one.ellipsized && !enKeys.has(one.key))
    expect(fresh, `${theme} new Korean overflow`).toEqual([])
  }
})
