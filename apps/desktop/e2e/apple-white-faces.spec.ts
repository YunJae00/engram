import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const M = 'APPLE-WHITE'

const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => getComputedStyle(node).backgroundColor)
const canvasBehind = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => {
  for (let at: Element | null = node; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
  }
  return getComputedStyle(document.body).backgroundColor
})
const face = async (where: string, locator: Locator, size: number) => {
  await expect(locator, `${M} ${where} face is visible`).toBeVisible()
  const box = (await locator.boundingBox())!
  expect(Math.abs(box.width - size), `${M} ${where} face width ${box.width} should be ${size}`).toBeLessThanOrEqual(1)
  expect(Math.abs(box.height - size), `${M} ${where} face height ${box.height} should be ${size}`).toBeLessThanOrEqual(1)
}

test('apple white chrome and larger faces', async () => {
  test.setTimeout(180_000)
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'apple-white-'))
  const userData = await mkdtemp(join(TMP, 'apple-white-user-'))
  let app: ElectronApplication | undefined
  try {
    const paths = await initVault(vault, { git: false })
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
    app = await electron.launch({
      args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1360, 860))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    const start = Date.now() - 3_600_000
    const chat = await createBot(paths, { name: 'Chat' }, new Date(start))
    await appendBotTurn(paths, chat.id, { role: 'user', text: 'Summarize the news', at: new Date(start + 60_000).toISOString() })
    await appendBotTurn(paths, chat.id, { role: 'assistant', text: 'Here are three items.', at: new Date(start + 120_000).toISOString() })
    const empty = await createBot(paths, { name: 'Empty' }, new Date(start + 1000))
    await createBot(paths, { name: 'Third' }, new Date(start + 2000))
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await openActivity(page, 'bots')
    const open = async (id: string) => {
      const row = page.getByTestId(`bot-${id}`), earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
    }

    await open(chat.id)
    await expect(page.locator('.bots-thread .bubble-msg.user')).toHaveCount(1)
    expect(await canvasBehind(page, '.bots-thread'), `${M} content canvas behind the thread`).toBe('rgb(255, 255, 255)')
    expect(await bg(page, '.bots-write .chat-write'), `${M} composer surface`).toBe('rgb(255, 255, 255)')
    const rail = await bg(page, '.app-sidebar')
    expect(rail, `${M} sidebar rail`).toBe('rgb(245, 245, 247)')
    const selected = await bg(page, '.app-sidebar .sidebar-item.active')
    expect(selected, `${M} selected sidebar row`).toBe('rgb(232, 232, 237)')
    expect(selected, `${M} selected row differs from the rail`).not.toBe(rail)
    expect(await bg(page, '.bots-thread .bubble-msg.user'), `${M} user bubble`).toBe('rgb(242, 242, 247)')
    expect(await page.locator('.bots-thread .bubble-msg.assistant').first().evaluate(node => getComputedStyle(node).color), `${M} body text`).toBe('rgb(28, 28, 30)')
    expect(await page.evaluate(() => getComputedStyle(document.body).color), `${M} body color`).toBe('rgb(28, 28, 30)')

    await face('sidebar row', page.locator(`[data-testid="bot-${chat.id}"] .sidebar-conversation-avatar > .bot-avatar`), 32)
    await face('title pill', page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar'), 36)
    await page.getByTestId('bots-title-pill').click()
    const pane = page.getByTestId('bot-info-pane')
    await expect(pane, `${M} info pane opens`).toBeVisible()
    await face('info pane', pane.locator('.bot-info-avatar .bot-avatar').first(), 64)
    await page.getByTestId('bots-title-pill').click()
    await expect(pane, `${M} info pane closes`).toHaveCount(0)

    await open(empty.id)
    await face('empty state', page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"] .bot-avatar'), 80)

    await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
    await page.getByTestId('bots-new').click()
    const dialog = page.locator('[role="dialog"][data-testid="create-bot-dialog"]')
    await expect(dialog, `${M} create-bot-dialog opens`).toBeVisible()
    await page.getByTestId('create-bot-name').fill('New')
    expect(await dialog.getByTestId('create-bot-submit').evaluate(node => getComputedStyle(node).backgroundColor), `${M} primary CTA`).toBe('rgb(28, 28, 30)')
    await face('create-bot-preview', dialog.locator('[data-testid="create-bot-preview"] .bot-avatar'), 80)
    await dialog.getByTestId('create-bot-avatar-change').click()
    await expect(dialog.locator('.avatar-picker-grid'), `${M} picker grid opens`).toBeVisible()
    const grid = await dialog.evaluate(node => {
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height } }
      const cells = [...node.querySelectorAll('.avatar-picker-cell')]
      return { dialog: rect(node), cells: cells.map(rect), faces: cells.map(cell => rect(cell.querySelector('.bot-avatar')!).width), overflow: node.scrollWidth - node.clientWidth }
    })
    expect(grid.cells.length, `${M} avatar-picker-cell count`).toBe(16)
    expect(new Set(grid.cells.map(cell => Math.round(cell.left))).size, `${M} picker has 4 columns`).toBe(4)
    for (const cell of grid.cells) {
      expect(Math.abs(cell.width - 56) <= 1 && Math.abs(cell.height - 56) <= 1, `${M} avatar-picker-cell ${cell.width}x${cell.height} should be 56`).toBe(true)
      expect(cell.left >= grid.dialog.left && cell.right <= grid.dialog.right, `${M} avatar-picker-cell inside create-bot-dialog`).toBe(true)
    }
    for (const width of grid.faces) expect(width, `${M} picker face ${width} fills the cell`).toBeGreaterThanOrEqual(48)
    expect(grid.overflow, `${M} create-bot-dialog has no horizontal overflow`).toBeLessThanOrEqual(0)
  } finally {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
