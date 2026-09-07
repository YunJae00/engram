import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createNote, initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-layout-vault-'))
  await createNote(await initVault(vault, { git: false }), { body: '# Layout review\n\nA memory for the list.' })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-layout-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  await page.evaluate(async () => {
    const ids: string[] = []
    for (const name of ['Research scout', 'Release planning', 'Product review', '팀 리서치와 제품 디자인 상세 검토']) {
      ids.push((await window.engram.botCreate({ name, purpose: 'A detailed project description that must stay on one line' })).id)
    }
    localStorage.setItem('engram.mission.slots', JSON.stringify(ids))
  })
})

test.afterAll(async () => { await app?.close() })

async function screenshot(name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes('index.html'))!
    // Wake a hidden window's compositor before capturing the resized frame.
    await window.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, name), Buffer.from(png, 'base64'))
}

async function navigate(view: string) {
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`activity-${view}`).click()
  if (view !== 'settings' && (page.viewportSize()?.width ?? 1280) <= 900) {
    await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => scrollX)).toBe(0)
  await expect.poll(() => page.locator('.topbar').evaluate((node) => {
    return node.getBoundingClientRect().right <= node.closest('.app-main')!.getBoundingClientRect().right + 1
  })).toBe(true)
}

test('shared headers and composers keep their rhythm at wide and compact sizes', async () => {
  for (const width of [1440, 948, 620]) {
    await page.setViewportSize({ width, height: 840 })
    await navigate('bots')
    const input = page.getByTestId('bots-input')
    await expect(input).toBeVisible()
    await input.fill('First line\nSecond line\nThird line')
    await expect(page.locator('.bots-head')).toHaveCount(0)
    await expect(page.locator('.topbar')).toHaveCSS('height', '44px')
    await expect(page.locator('.topbar .bots-head-name')).toBeVisible()
    await expect(page.locator('.bots-write .chat-write')).toHaveCSS('border-radius', '22px')
    await expect.poll(() => page.locator('.bots-write').evaluate((node) => {
      const box = node.getBoundingClientRect()
      const host = node.closest('.bots-chat')!.getBoundingClientRect()
      return Math.abs((box.left - host.left) - (host.right - box.right))
    })).toBeLessThanOrEqual(1)
    await page.getByTestId('composer-web').click()
    await expect(page.getByTestId('web-pane')).toBeVisible()
    await expect(page.locator('.web-pane-bar')).toHaveCSS('min-height', '44px')
    if (width <= 1180) {
      await expect.poll(() => page.getByTestId('web-pane').evaluate((node) => {
        const pane = node.getBoundingClientRect()
        const host = node.closest('.bots-main')!
        const input = host.querySelector('.bots-write')!.getBoundingClientRect()
        const head = host.getBoundingClientRect()
        return pane.bottom <= input.top && pane.top >= head.top && pane.width > 300
      })).toBe(true)
    }
    await page.getByTestId('web-pane-fold').click()
    await expect(page.getByTestId('web-pane')).toHaveCount(0)
    await input.fill('')
    await navigate('sky')
    await expect(page.locator('.cosmos-chat-head')).toHaveCSS('min-height', '44px')
    await expect(page.locator('.cosmos-chat .chat-write')).toHaveCSS('border-radius', '22px')
    await navigate('list')
    await expect(page.locator('.view-filter-bar')).toHaveCSS('min-height', '56px')
  }
})

test('settings header, rows and footer share an inset without nested modal padding', async () => {
  for (const width of [1280, 620]) {
    await page.setViewportSize({ width, height: 720 })
    await navigate('settings')
    await expect(page.getByTestId('setting-desk-journal')).toBeVisible()
    const box = page.locator('.brief-box.settings-box')
    await expect(box).toHaveCSS('padding', '0px')
    await expect(box).toHaveCSS('gap', '0px')
    await expect.poll(() => box.evaluate((node) => {
      const head = node.querySelector('.dialog-head')!
      const scroll = node.querySelector('.settings-scroll')!
      const foot = node.querySelector('.dialog-actions')!
      const inset = (element: Element) => element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft)
      const model = node.querySelector('[data-testid="model-codex"]')!.getBoundingClientRect()
      const select = node.querySelector('[data-testid="model-claude"]')!.getBoundingClientRect()
      const valueColumns = [...node.querySelectorAll('.settings-fact-value')].map((value) => value.getBoundingClientRect().left)
      return {
        contentAligned: Math.abs(inset(head) - inset(scroll)) <= 1,
        footerAligned: Math.abs(inset(head) - inset(foot)) <= 1,
        fieldsAligned: Math.abs(model.width - select.width) <= 1,
        columnsAligned: valueColumns.every((left) => Math.abs(left - select.left) <= 1),
        fitsWidth: model.right <= node.getBoundingClientRect().right,
        fitsHeight: node.getBoundingClientRect().bottom <= innerHeight,
      }
    })).toEqual({ contentAligned: true, footerAligned: true, fieldsAligned: true, columnsAligned: true, fitsWidth: true, fitsHeight: true })
    await page.keyboard.press('Escape')
  }
})

test('mission tiles preserve usable previews and inputs instead of clipping at narrow widths', async () => {
  for (const [width, height] of [[1600, 840], [948, 760], [620, 720]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await navigate('mission')
    await expect(page.locator('.mission-tile .mini-chat')).toHaveCount(4)
    await expect.poll(() => page.locator('.mission-tile').evaluateAll((tiles) => tiles.every((tile) => {
      const bounds = tile.getBoundingClientRect()
      const preview = tile.querySelector('.mission-preview')!.getBoundingClientRect()
      const input = tile.querySelector('.mini-chat-write input')!.getBoundingClientRect()
      return preview.width >= 140 && input.width >= 120 && input.left >= bounds.left && input.right <= bounds.right
        && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight + 1
    }))).toBe(true)
    await screenshot(`orbit-layout-${width}.png`)
  }
})

test('tile conversations and chat pickers unfold without losing the draft', async () => {
  for (const width of [1600, 948, 620]) {
    await page.setViewportSize({ width, height: 840 })
    await navigate('mission')
    const tile = page.getByTestId('mission-tile-0')
    const toggle = page.getByTestId('mission-chat-toggle-0')
    const input = tile.locator('.mini-chat-write input')
    await input.fill('Keep this draft 한글')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(tile.locator('.mission-chat-slot')).toBeHidden()
    expect(await tile.locator('.mission-chat-slot').evaluate((node) => (node as HTMLElement).inert)).toBe(true)
    await toggle.click()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Keep this draft 한글')
    const choose = tile.locator('.mission-change')
    await choose.click()
    await expect(page.getByTestId('mission-add-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(choose).toBeFocused()
    await expect(tile.locator('.mission-add-menu')).toBeHidden()
    await choose.click()
    await page.locator('.mission-head').click({ position: { x: 10, y: 10 } })
    await expect(tile.locator('.mission-add-menu')).toBeHidden()
    await expect(input).toHaveValue('Keep this draft 한글')
    await input.fill('')
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('mission-tile-0').locator('.mission-tile-body')).toHaveCSS('transition-duration', '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test('the last answer stays above the composer and its soft scroll edge as the draft grows', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', () => ({ ok: true }))
  })
  await page.setViewportSize({ width: 620, height: 720 })
  await navigate('bots')
  const title = await page.locator('.bots-head-name').textContent()
  const id = await page.evaluate(async (name) => (await window.engram.botsList()).find((bot) => bot.name === name)!.id, title)
  const input = page.getByTestId('bots-input')
  await input.fill('Show a detailed review')
  await input.press('Enter')
  await expect(page.locator('.bots-write .bubble-stop')).toBeVisible()
  await app.evaluate(({ BrowserWindow }, botId) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', {
      type: 'chat:done', channel: `bot-${botId}`,
      text: Array.from({ length: 28 }, (_, i) => `Review item ${i + 1}: spacing, typography and page alignment.`).join('\n\n') + '\n\nFinal visible line.',
    })
  }, id)
  await expect(page.locator('.bots-thread')).toContainText('Final visible line.')
  for (const draft of ['', 'One\nTwo\nThree\nFour\nFive\nSix']) {
    await input.fill(draft)
    await expect.poll(() => page.locator('.bots-thread').evaluate((node) => {
      const last = node.querySelector('.bubble-msg.assistant:last-of-type p:last-child')!
      const line = last.getBoundingClientRect()
      const thread = node.getBoundingClientRect()
      const composer = node.closest('.bots-chat')!.querySelector('.bots-write')!.getBoundingClientRect()
      return line.bottom <= thread.bottom - 18 && line.bottom < composer.top && line.top >= thread.top
    })).toBe(true)
  }
  await screenshot('conversation-compact.png')
  await input.fill('')
  await navigate('sky')
  await screenshot('cosmos-compact.png')
})
