import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp } from '../navigation.js'
import { visualDir, writeReviewSheet } from './review-sheet.js'
import { CHAT_ID, seedVisualVault } from './seed.js'
import { galleryHtml } from './avatar-gallery.js'
import { measureChat, measureState, serializeMetrics, type StateName } from './spec.js'

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
      await expect(page.locator('#bot-info-tab-overview')).toHaveAttribute('aria-selected', 'true')
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
      await page.locator('#bot-info-tab-routines').click()
      await expect(page.getByTestId('bot-routine-vis-paused-task')).toBeVisible()
    })
  })

  test('info-past', async () => {
    await capture('info-past', async (page, _theme, app) => {
      const vault = await app.evaluate(() => process.env['ENGRAM_VAULT']!)
      const file = join(vaultPaths(vault).cache, 'bot-chats', `${CHAT_ID}.2026-01-05T12-00-00.jsonl`)
      await writeFile(file, [
        { role: 'user', text: 'Which bulbs did we pick last autumn?', at: '2026-01-05T12:00:00.000Z' },
        { role: 'assistant', text: 'Tulips and daffodils, planted along the fence.', at: '2026-01-05T12:00:04.000Z' },
      ].map(turn => JSON.stringify(turn)).join('\n') + '\n')
      const row = page.getByTestId(`bot-${CHAT_ID}`)
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
      await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').first()).toBeVisible()
      await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
      const pane = page.getByTestId('bot-info-pane'), panel = page.locator('#bot-info-panel-past')
      await expect(pane).toBeVisible()
      await page.locator('#bot-info-tab-past').click()
      await expect(panel.getByTestId('bot-past-item')).toHaveCount(1)
      await panel.getByTestId('bot-past-item').click()
      await expect(pane.getByTestId('bot-past-view').locator('.bubble-msg')).toHaveCount(2)
      await expect(panel.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0)
      await expect(pane.locator('[data-testid="bots-input"]')).toHaveCount(0)
      const style = (sel: string) => page.locator(sel).first().evaluate(el => (s => [s.backgroundColor, s.color, s.fontSize, s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius, s.paddingTop, s.paddingLeft])(getComputedStyle(el)))
      for (const role of ['user', 'assistant']) {
        expect(await style(`[data-testid="bot-past-view"] .bubble-msg.${role}`)).toEqual(await style(`[data-testid="bots-thread"] .bubble-msg.${role}`))
      }
    })
    for (const theme of THEMES) {
      const rows = JSON.parse(await readFile(join(OUT, `info-past-${theme}.metrics.json`), 'utf8')) as { row: number; status: string }[]
      expect(rows.find(r => r.row === 17)?.status).toBe('pass')
    }
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

  for (const state of ['settings-review', 'onboarding-bot'] as const) {
    test.fixme(state, () => undefined)
  }
})
