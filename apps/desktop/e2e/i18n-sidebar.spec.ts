import { expect, test, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'
import { measureChat, type RowRecord } from './visual/spec.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const THEMES = ['light', 'dark'] as const
interface Overflow { key: string; ellipsized: boolean; line: boolean }

async function measure(theme: typeof THEMES[number], lang: 'en' | 'ko'): Promise<{ rows: RowRecord[]; overflow: Overflow[] }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'i18n-sidebar-vault-')), profile = await mkdtemp(join(TMP, 'i18n-sidebar-profile-'))
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
    await expect(page.getByTestId('bots-new')).toBeEnabled()
    await expect(page.getByTestId('activity-settings')).toHaveAttribute('aria-label', lang === 'en' ? 'Settings' : '설정')
    const row = page.getByTestId(`bot-${chatId}`)
    const earlier = page.getByTestId('sidebar-earlier')
    if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
    await row.click()
    await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').first()).toBeVisible()
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engram:event', { type: 'chat:offer', channel: `bot-${id}`, offer: { kind: 'asked', question: 'Which vegetables should go in the patch?', options: ['Lettuce and radish', 'Beans and peas'] } })
    }, chatId)
    await expect(page.locator('[data-testid="bots-view"] [data-testid="bots-choices"] .decision-card')).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const rows = await measureChat(page)
    const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.app-sidebar *')]
      .filter(el => el.checkVisibility({ checkVisibilityCSS: true }) && el.scrollWidth > el.clientWidth)
      .map(el => {
        const cs = getComputedStyle(el)
        return {
          key: `${el.tagName}.${[...el.classList].sort().join('.')}`,
          ellipsized: cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible',
          line: !!el.closest('.sidebar-conversation-name, .sidebar-conversation-preview, .sidebar-primary-name'),
        }
      }))
    return { rows, overflow }
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
  }
}

const overflowOf = (rows: RowRecord[]) => rows.find(one => one.row === 17)?.checks[0]?.measured

test('Korean sidebar keeps the layout: rows 1-6 and 17 hold and only name and preview lines ellipsize', async () => {
  test.setTimeout(240_000)
  for (const theme of THEMES) {
    const en = await measure(theme, 'en')
    const ko = await measure(theme, 'ko')
    for (const record of en.rows.filter(one => one.row >= 1 && one.row <= 6)) {
      for (const check of record.checks.filter(one => one.status === 'pass')) {
        const korean = ko.rows.find(one => one.row === record.row)?.checks.find(one => one.what === check.what)
        expect(korean?.status, `${theme} row ${record.row} ${check.what}: ${JSON.stringify(korean)}`).toBe('pass')
      }
    }
    const enCount = overflowOf(en.rows), koCount = overflowOf(ko.rows)
    expect(typeof enCount, `${theme} row 17 en`).toBe('number')
    expect(typeof koCount, `${theme} row 17 ko`).toBe('number')
    expect(koCount as number, `${theme} row 17`).toBeLessThanOrEqual(enCount as number)
    const enKeys = new Set(en.overflow.map(one => one.key))
    const fresh = ko.overflow.filter(one => !(one.ellipsized && one.line) && !enKeys.has(one.key))
    expect(fresh, `${theme} new Korean sidebar overflow`).toEqual([])
  }
})
