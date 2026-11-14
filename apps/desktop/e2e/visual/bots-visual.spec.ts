import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from '../navigation.js'
import { visualDir, writeReviewSheet } from './review-sheet.js'
import { CHAT_ID, seedVisualVault } from './seed.js'
import { galleryHtml } from './avatar-gallery.js'
import { contrastRatio, measureChat, measureState, serializeMetrics, type Rgba, type StateName } from './spec.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const OUT = visualDir(REPO)
const THEMES = ['light', 'dark'] as const
type Theme = typeof THEMES[number]

async function launch(theme: Theme): Promise<{ app: ElectronApplication; chatId: string; dirs: string[] }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'visual-vault-')), profile = await mkdtemp(join(TMP, 'visual-profile-'))
  const { chatId } = await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  return { app, chatId, dirs: [vault, profile] }
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

test.describe('visual', () => {
  test.skip(process.env['ENGRAM_VISUAL'] !== '1', 'Opt-in visual harness: set ENGRAM_VISUAL=1')
  test.afterAll(async () => { await writeReviewSheet(REPO) })

  test('chat', async () => {
    await mkdir(OUT, { recursive: true })
    for (const theme of THEMES) for (const ext of ['png', 'metrics.json']) await rm(join(OUT, `chat-${theme}.${ext}`), { force: true })
    for (const theme of THEMES) {
      const { app, chatId, dirs } = await launch(theme)
      try {
        const page = await prepare(app)
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
        await page.screenshot({ path: join(OUT, `chat-${theme}.png`), caret: 'hide', animations: 'disabled', scale: 'css' })
        await writeFile(join(OUT, `chat-${theme}.metrics.json`), serializeMetrics(rows))
      } finally {
        await closeTestApp(app)
        for (const dir of dirs) await rm(dir, { recursive: true, force: true })
      }
    }
  })

  const capture = async (state: StateName, show: (page: Page, theme: Theme, app: ElectronApplication) => Promise<void>) => {
    await mkdir(OUT, { recursive: true })
    for (const theme of THEMES) for (const ext of ['png', 'metrics.json']) await rm(join(OUT, `${state}-${theme}.${ext}`), { force: true })
    for (const theme of THEMES) {
      const { app, dirs } = await launch(theme)
      try {
        const page = await prepare(app)
        await show(page, theme, app)
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const rows = await measureState(page, state)
        await page.screenshot({ path: join(OUT, `${state}-${theme}.png`), caret: 'hide', animations: 'disabled', scale: 'css' })
        await writeFile(join(OUT, `${state}-${theme}.metrics.json`), serializeMetrics(rows))
      } finally {
        await closeTestApp(app)
        for (const dir of dirs) await rm(dir, { recursive: true, force: true })
      }
    }
  }

  test('sidebar-states', async () => {
    await capture('sidebar-states', async page => {
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await page.getByTestId('bot-vis-chat').isVisible() && await earlier.isVisible()) await earlier.click()
      await expect(page.locator('.sidebar-conversations .bots-row .bot-avatar').first()).toBeVisible()
    })
  })

  test('avatar-gallery', async () => {
    await capture('avatar-gallery', async (page, theme) => { await page.setContent(await galleryHtml(theme)) })
  })

  test('toast', async () => {
    await capture('toast', async (page, _theme, app) => {
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engram:event', { type: 'task:notice', message: 'Visual toast' })
      })
      const toast = page.locator('.toast')
      await expect(toast).toBeVisible()
      const box = await toast.boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    })
  })

  test('info-overview', async () => {
    await capture('info-overview', async page => {
      const row = page.getByTestId(`bot-${CHAT_ID}`)
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
      await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').first()).toBeVisible()
      await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
      await expect(page.getByTestId('bot-info-pane')).toBeVisible()
      await expect(page.getByTestId('bot-info-pane').locator('[role=tablist], [role=tab]')).toHaveCount(0)
    })
  })

  test('create-dialog', async () => {
    await capture('create-dialog', async page => {
      await page.getByTestId('sidebar-create').click()
      await page.getByTestId('bots-new').click()
      await expect(page.getByTestId('create-bot-dialog')).toBeVisible()
    })
  })

  test('avatar-picker', async () => {
    await capture('avatar-picker', async page => {
      await page.getByTestId('sidebar-create').click()
      await page.getByTestId('bots-new').click()
      await page.getByTestId('create-bot-avatar-change').click()
      await expect(page.locator('[data-testid="avatar-picker"]')).toBeVisible()
    })
  })

  test('info-routines', async () => {
    await capture('info-routines', async page => {
      const row = page.getByTestId('bot-vis-paused')
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
      await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
      await expect(page.getByTestId('bot-info-pane')).toBeVisible()
      await expect(page.getByTestId('bot-routine-vis-paused-task')).toBeVisible()
    })
  })

  test('empty-bot', async () => {
    await capture('empty-bot', async page => {
      await page.evaluate(() => window.engram.botUpdate('vis-new', { label: 'Helper' }))
      const row = page.getByTestId('bot-vis-new')
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
      const empty = page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"]')
      await expect(empty).toBeVisible()
      await expect(empty.getByTestId('bot-empty-chip')).toHaveCount(3)
      await expect(page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')).toBeFocused()
      const avatar = (await empty.locator('.bot-avatar').first().boundingBox())!, thread = (await page.getByTestId('bots-thread').boundingBox())!
      expect(Math.abs(avatar.width - 64)).toBeLessThanOrEqual(1)
      expect(Math.abs(avatar.height - 64)).toBeLessThanOrEqual(1)
      expect(Math.abs(avatar.x + avatar.width / 2 - (thread.x + thread.width / 2))).toBeLessThanOrEqual(4)
      const font = (sel: string) => empty.locator(sel).evaluate(el => (s => [s.fontSize, s.fontWeight])(getComputedStyle(el)))
      await expect(empty.locator('.bot-empty-name')).toHaveText('New helper')
      expect(await font('.bot-empty-name')).toEqual(['18px', '600'])
      await expect(empty.locator('.bot-empty-label')).toHaveText('Helper')
      expect((await font('.bot-empty-label'))[0]).toBe('13px')
    })
    for (const theme of THEMES) {
      const rows = JSON.parse(await readFile(join(OUT, `empty-bot-${theme}.metrics.json`), 'utf8')) as { row: number; status: string }[]
      expect(rows.find(r => r.row === 17)?.status).toBe('pass')
    }
  })

  test('settings-review', async () => {
    const contrast: { theme: Theme; text: number | null; headings: (number | null)[]; ring: number | null }[] = []
    await capture('settings-review', async (page, theme) => {
      const openAi = async () => {
        await page.getByTestId('activity-settings').click()
        await page.getByTestId('settings-nav-ai').click()
        await expect(page.getByTestId('review-rules')).toBeVisible()
      }
      await openAi()
      for (const [kind, host] of [['ask-first', 'example.com'], ['allow', 'docs.example.org']] as const) {
        await page.getByTestId(`review-rule-input-${kind}`).fill(host)
        await page.getByTestId(`review-rule-add-${kind}`).click()
        await expect(page.getByTestId(`review-rules-${kind}`).getByTestId('review-rule-row')).toHaveText([new RegExp(host.replace('.', '\\.'))])
      }
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await openAi()
      await expect(page.getByTestId('review-rule-row')).toHaveCount(2)
      expect(await page.evaluate(() => window.engram.reviewRulesList())).toEqual([
        { kind: 'ask-first', operation: 'submit', target: 'example.com' },
        { kind: 'allow', operation: 'submit', target: 'docs.example.org' },
      ])
      const input = page.getByTestId('review-rule-input-ask-first')
      await page.getByTestId('review-rules').scrollIntoViewIfNeeded()
      await input.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      const colors = await page.evaluate(() => {
        const layers = (el: Element | null) => { const out: string[] = []; for (; el; el = el.parentElement) out.push(getComputedStyle(el).backgroundColor); return out }
        const host = document.querySelector('[data-testid="review-rule-row"] > span')!
        const heads = [...document.querySelectorAll('[data-testid="review-rules"] h4')]
        const field = document.querySelector<HTMLElement>('[data-testid="review-rule-input-ask-first"]')!
        const cs = getComputedStyle(field)
        const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? cs.outlineColor : cs.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? ''
        return { text: [getComputedStyle(host).color, ...layers(host)], heads: heads.map(h => [getComputedStyle(h).color, ...layers(h)]), ring: [ring, ...layers(field.parentElement)] }
      })
      const rgba = (list: string[]) => page.evaluate(values => {
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
        ctx.canvas.width = 1
        ctx.canvas.height = 1
        ctx.globalCompositeOperation = 'copy'
        return values.map(value => {
          ctx.fillStyle = value
          ctx.fillRect(0, 0, 1, 1)
          const d = ctx.getImageData(0, 0, 1, 1).data
          return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as [number, number, number, number]
        })
      }, list)
      const ratio = async ([fg, ...layers]: string[]) => { const [f, ...l] = await rgba([fg!, ...layers]); return contrastRatio(f as Rgba, l as Rgba[]) }
      contrast.push({ theme, text: await ratio(colors.text), headings: await Promise.all(colors.heads.map(ratio)), ring: colors.ring[0] ? await ratio(colors.ring) : null })
    })
    for (const theme of THEMES) {
      const rows = JSON.parse(await readFile(join(OUT, `settings-review-${theme}.metrics.json`), 'utf8')) as { row: number; status: string }[]
      expect(rows.find(r => r.row === 17)?.status).toBe('pass')
    }
    expect(contrast.map(c => c.theme)).toEqual([...THEMES])
    for (const c of contrast) {
      expect(c.text, `${c.theme} host text`).toBeGreaterThanOrEqual(4.5)
      expect(c.headings, `${c.theme} headings`).toHaveLength(2)
      for (const h of c.headings) expect(h, `${c.theme} heading`).toBeGreaterThanOrEqual(4.5)
      expect(c.ring, `${c.theme} focus ring`).toBeGreaterThanOrEqual(3)
    }
  })

  test('onboarding-bot', async () => {
    await mkdir(OUT, { recursive: true })
    for (const theme of THEMES) {
      const profile = await mkdtemp(join(TMP, 'visual-onboard-profile-')), root = await mkdtemp(join(TMP, 'visual-onboard-root-'))
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
      await mkdir(join(profile, 'mock')); await writeFile(join(profile, 'mock', 'default.txt'), 'OK')
      const app = await electron.launch({ args: [fileURLToPath(new URL('../../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
        ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: profile, ENGRAM_ONBOARD_ROOT: join(root, 'Engram'),
        ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_BROWSER_EXTERNAL: '0',
      } })
      try {
        const page = await app.firstWindow()
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' }); await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await page.getByTestId('onboard-next').click()
        await app.evaluate(({ ipcMain, BrowserWindow }, dir) => {
          process.env['ENGRAM_ENGINE'] = 'mock'; process.env['ENGRAM_MOCK_DIR'] = dir
          ipcMain.removeHandler('engines:states'); ipcMain.handle('engines:states', () => [{ id: 'claude', installed: true, loggedIn: true }])
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
        }, join(profile, 'mock'))
        await expect(page.getByTestId('onboard-brain-claude')).toBeVisible()
        await expect(page.getByTestId('onboard-choice')).toHaveCount(0)
        await page.getByTestId('onboard-ai-next').click()
        await page.getByTestId('onboard-prefs-next').click()
        await expect(page.getByTestId('onboard-step-4')).toBeVisible()
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        // Row 17 probes the shell; onboarding has none, so its root stands in only while measured.
        await page.getByTestId('onboarding').evaluate(el => el.setAttribute('data-testid', 'shell'))
        const rows = await measureState(page, 'onboarding-bot')
        await page.getByTestId('shell').evaluate(el => el.setAttribute('data-testid', 'onboarding'))
        expect(rows.find(r => r.row === 17)?.status, `${theme} row 17`).toBe('pass')
        const avatar = (await page.locator('[data-testid="onboard-step-4"] .bot-avatar').boundingBox())!
        expect(Math.abs(avatar.width - 64)).toBeLessThanOrEqual(1)
        expect(Math.abs(avatar.height - 64)).toBeLessThanOrEqual(1)
        const pairs = await page.evaluate(() => {
          const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
          ctx.canvas.width = 1; ctx.canvas.height = 1; ctx.globalCompositeOperation = 'copy'
          const rgba = (value: string) => { ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as [number, number, number, number] }
          const stack = (el: Element) => { const out = [rgba(getComputedStyle(el).color)]; for (let at: Element | null = el; at; at = at.parentElement) out.push(rgba(getComputedStyle(at).backgroundColor)); return out }
          return [stack(document.querySelector('[data-testid="onboard-step-4"] h1')!), stack(document.querySelector('[data-testid="onboard-bot-name"]')!)]
        })
        for (const [fg, ...layers] of pairs) expect(contrastRatio(fg as Rgba, layers as Rgba[]), `${theme} text contrast`).toBeGreaterThanOrEqual(4.5)
        await page.screenshot({ path: join(OUT, `onboarding-bot-${theme}.png`), caret: 'hide', animations: 'disabled', scale: 'css' })
        await writeFile(join(OUT, `onboarding-bot-${theme}.metrics.json`), serializeMetrics(rows))
      } finally {
        await closeTestApp(app)
        for (const dir of [profile, root]) await rm(dir, { recursive: true, force: true })
      }
    }
  })
})
