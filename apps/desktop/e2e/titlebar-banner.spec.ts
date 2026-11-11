import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const EN = "Claude is selected for filing but isn't ready. Check its connection or choose another AI in Settings."
const KO = '정리에 쓰도록 선택한 AI가 준비되지 않았어요: Claude. 연결을 확인하거나 설정에서 다른 AI를 고르세요.'

async function withApp(engine: string, settings: object, run: (page: Page, app: ElectronApplication) => Promise<void>): Promise<void> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-titlebar-')), profile = await mkdtemp(join(TMP, 'e2e-titlebar-profile-'))
  let app: ElectronApplication | undefined
  try {
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', ...settings }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: engine, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    await run(page, app)
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
  }
}

async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()])
  return !!a && !!b && a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1
}

test('the title row shows no bot name and carries the AI connect banner', async () => {
  await withApp('none', { uiLanguage: 'en' }, async (page, app) => {
    await page.getByTestId('bot-vis-chat').click()
    await expect(page.getByTestId('bots-view')).toBeVisible()
    await expect(page.locator('.bots-head-name, .conversation-title')).toHaveCount(0)
    const topbar = page.getByTestId('topbar'), banner = page.getByTestId('connect-banner')
    await expect(banner).toBeVisible()
    expect(await inside(banner, topbar)).toBe(true)
    await expect(page.locator('.notices [data-testid="connect-banner"]')).toHaveCount(0)
    await page.setViewportSize({ width: 620, height: 800 })
    const button = banner.getByRole('button', { name: 'AI settings' })
    await expect(button).toBeVisible()
    await expect.poll(() => inside(button, topbar)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'task:notice', message: 'Filing finished' })
    })
    await expect(page.locator('.toast')).toBeVisible()
    expect(await inside(banner, topbar)).toBe(true)
    await page.getByTestId('mission-layout-2').click()
    await expect(page.getByTestId('mission-layout-2')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.bots-head-name, .conversation-title')).toHaveCount(0)
    await expect.poll(() => inside(banner, topbar)).toBe(true)
    await expect(page.locator('.notices [data-testid="connect-banner"]')).toHaveCount(0)
    await button.click()
    await expect(page.getByTestId('settings-view')).toBeVisible()
  })
})

test('with an AI connected the title slot is gone and the pill still opens the info pane', async () => {
  await withApp('mock', { uiLanguage: 'en' }, async (page) => {
    await page.getByTestId('bot-vis-chat').click()
    await expect(page.getByTestId('bots-view')).toBeVisible()
    const pill = page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]')
    await expect(pill).toBeVisible()
    await expect(page.getByTestId('connect-banner')).toHaveCount(0)
    await expect(page.locator('[data-testid="topbar"] .topbar-title')).toHaveCount(0)
    await expect(pill.locator('.bots-title-pill-name')).not.toHaveText('')
    await pill.click()
    await expect(page.getByTestId('bot-info-pane')).toBeVisible()
    await page.getByTestId('mission-layout-2').click()
    await expect(page.getByTestId('mission-layout-2')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="topbar"] .topbar-title')).toHaveCount(0)
    await expect(page.locator('.bots-head-name, .conversation-title')).toHaveCount(0)
  })
})

test('the filing-not-ready banner reads in Korean and English', async () => {
  const filing = { aiSelections: { filing: { engine: 'claude' } } }
  await withApp('none', { ...filing, uiLanguage: 'ko' }, async (page) => {
    const banner = page.getByTestId('connect-banner')
    await expect(banner).toContainText(KO)
    await expect(banner.getByRole('button', { name: 'AI 설정' })).toBeVisible()
  })
  await withApp('none', { ...filing, uiLanguage: 'en' }, async (page) => {
    const banner = page.getByTestId('connect-banner')
    await expect(banner).toContainText(EN)
    await expect(banner.getByRole('button', { name: 'AI settings' })).toBeVisible()
  })
})

test('update banner stays in the strip under the title row', async () => {
  await withApp('mock', { uiLanguage: 'en' }, async (page, app) => {
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'update:changed', update: { version: '9.9.9', state: 'available' } })
    })
    const banner = page.locator('.notices [data-testid="update-banner"]')
    await expect(banner).toBeVisible()
    const [topbarBox, bannerBox] = await Promise.all([page.getByTestId('topbar').boundingBox(), banner.boundingBox()])
    expect(bannerBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height - 1)
  })
})
