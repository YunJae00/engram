import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { createNote, initVault } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let server: Server

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
    for (const name of ['Research scout', 'Release planning', 'Product review', '팀 리서치와 제품 디자인 상세 검토']) {
      await window.engram.botCreate({ name, purpose: 'A detailed project description that must stay on one line' })
    }
  })
  await page.locator('.bots-row', { hasText: 'Research scout' }).click()
  // A preview card is drawn only for a page that is open (grokbar c3a), so the chat under test has one.
  server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<html><title>Layout fixture</title><h1>Layout fixture</h1></html>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const lane = (await page.locator('.bots-row.active').getAttribute('data-testid'))!
  await page.evaluate(async ({ lane, url }) => window.engram.agentGo(url, lane), { lane, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })
})

test.afterAll(async () => {
  await app?.close()
  server?.closeAllConnections()
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
})

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
  await openActivity(page, view)
  if (view !== 'settings' && (page.viewportSize()?.width ?? 1280) <= 900) {
    await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => scrollX)).toBe(0)
  await expect.poll(() => page.locator('.topbar').evaluate((node) => {
    return node.getBoundingClientRect().right <= node.closest('.app-main')!.getBoundingClientRect().right + 1
  })).toBe(true)
}

// Page work in the open chat brings its preview card; a card hidden earlier is shown again.
async function pageWork() {
  const lane = (await page.locator('.bots-row.active').getAttribute('data-testid'))!
  await app.evaluate(({ BrowserWindow }, channel) => {
    for (const line of ['excel_write: sheet', 'open_page: page']) for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'comet:step', channel, line })
  }, lane)
  const reopen = page.getByTestId('preview-card-reopen')
  await expect(page.getByTestId('preview-card').or(reopen)).toBeVisible()
  if (await reopen.isVisible()) await reopen.click()
  await expect(page.getByTestId('preview-card')).toBeVisible()
}

// Wide windows open the page beside the chat; compact ones open it full and return to the card.
async function openAndPutAwayPage(width: number) {
  const pane = page.getByTestId('web-pane')
  await page.getByTestId('preview-card').getByRole('button', { name: width > 1180 ? 'Open browser beside chat' : 'Open full browser', exact: true }).click()
  await expect(pane).toBeVisible()
  if (width > 1180) await page.getByTestId('web-pane-fold').click()
  else {
    await expect(pane).toHaveClass(/expanded/)
    await page.getByTestId('web-pane-expand').click()
    await expect(page.getByTestId('preview-card')).toBeVisible()
  }
  await expect(pane).toHaveCount(0)
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
    await expect(page.locator('.topbar .bots-head-name')).toHaveCount(0)
    await expect(page.locator('.bots-write .chat-write')).toHaveCSS('border-radius', '22px')
    await expect.poll(() => page.locator('.bots-write').evaluate((node) => {
      const box = node.getBoundingClientRect()
      const host = node.closest('.bots-chat')!.getBoundingClientRect()
      return Math.abs((box.left - host.left) - (host.right - box.right))
    })).toBeLessThanOrEqual(1)
    expect(await page.locator('.bots-chat').evaluate((node) => {
      const thread = node.querySelector('.bots-thread')!
      const style = getComputedStyle(thread)
      const content = thread.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return node.querySelector('.bots-write')!.getBoundingClientRect().width - content
    })).toBeGreaterThanOrEqual(30)
    // The composer has no page-panel button: the panel arrives with page work as a card, which opens beside the chat on wide windows.
    await expect(page.getByTestId('composer-web')).toHaveCount(0)
    const lane = (await page.locator('.bots-row.active').getAttribute('data-testid'))!
    await app.evaluate(({ BrowserWindow }, channel) => {
      for (const line of ['excel_write: sheet', 'open_page: page']) for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'comet:step', channel, line })
    }, lane)
    const reopen = page.getByTestId('preview-card-reopen')
    await expect(page.getByTestId('preview-card').or(reopen)).toBeVisible()
    if (await reopen.isVisible()) await reopen.click()
    if (width > 1180) await page.getByTestId('preview-card').getByRole('button', { name: 'Open browser beside chat', exact: true }).click()
    const pane = width > 1180 ? page.getByTestId('web-pane') : page.getByTestId('preview-card')
    await expect(pane).toBeVisible()
    if (width > 1180) {
      await expect(page.locator('.web-pane-inner')).toHaveCSS('border-radius', '0px')
      await expect(page.locator('.web-pane-inner')).toHaveCSS('border-top-width', '0px')
      await expect(page.locator('.web-pane-inner')).toHaveCSS('box-shadow', 'none')
      await expect(page.getByTestId('web-pane')).toHaveCSS('margin', '0px')
      await expect(page.getByTestId('web-pane')).toHaveCSS('box-shadow', 'none')
      await expect(page.locator('.web-pane-bar')).toHaveCSS('min-height', '44px')
    } else {
      await expect(pane).toBeVisible()
      await expect(page.getByTestId('live-address')).toHaveCount(0)
    }
    await screenshot(`release-112-web-flat-${width}.png`)
    if (width <= 1180) {
      await expect.poll(() => pane.evaluate((node) => {
        const pane = node.getBoundingClientRect()
        const host = node.closest('.bots-main')!
        const head = host.getBoundingClientRect()
        const chat = host.querySelector('.bots-chat')!.getBoundingClientRect()
        return pane.top >= head.top && pane.right <= head.right && Math.abs(chat.width - head.width) < 2
      })).toBe(true)
    }
    if (width > 1180) await page.getByTestId('web-pane-fold').click(); else await pane.getByRole('button', { name: 'Hide preview', exact: true }).click()
    await expect(pane).toHaveCount(0)
    await input.fill('')
    await navigate('sky')
    await expect(page.locator('.cosmos-chat-head')).toHaveCSS('min-height', '44px')
    await expect(page.locator('.cosmos-chat .chat-write')).toHaveCSS('border-radius', '22px')
    await navigate('list')
    await expect(page.locator('.view-filter-bar')).toHaveCSS('min-height', '56px')
  }
})

test('one conversation fills the window at every width and its page opens beside it or full, never in a split pane', async () => {
  for (const width of [2600, 1600, 620]) {
    await page.setViewportSize({ width, height: 920 })
    await navigate('bots')
    for (const count of [1, 2, 4]) await expect(page.getByTestId(`mission-layout-${count}`)).toHaveCount(0)
    await expect(page.locator('.mission-tile, .mini-chat')).toHaveCount(0)
    await expect(page.locator('.bots-chat')).toHaveCount(1)
    await expect(page.getByTestId('composer-web')).toHaveCount(0)
    await expect.poll(() => page.locator('.bots-chat').evaluate((node) => {
      const chat = node.getBoundingClientRect(), main = node.closest('.bots-main')!.getBoundingClientRect()
      const write = node.querySelector('.bots-write')!.getBoundingClientRect()
      return chat.left >= main.left && chat.right <= main.right + 1 && main.right <= innerWidth + 1 && write.left >= chat.left && write.right <= chat.right && write.bottom <= innerHeight + 1
    })).toBe(true)
    await pageWork()
    await screenshot(`single-chat-${width}.png`)
    await openAndPutAwayPage(width)
    await expect(page.getByTestId('mission-browser-dialog')).toHaveCount(0)
    await expect(page.getByTestId('bots-input')).toBeVisible()
  }
})

test('the conversation shows animated pending status and elapsed time without an empty answer', async () => {
  await page.setViewportSize({ width: 1600, height: 920 })
  await navigate('bots')
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('chat:send'); ipcMain.handle('chat:send', () => undefined) })
  const thread = page.getByTestId('bots-thread')
  await page.getByTestId('bots-input').fill('Review the project')
  await page.getByTestId('bots-input').press('Enter')
  const status = thread.getByTestId('bots-thinking')
  await expect(status).toBeVisible()
  await expect(status.locator('.thinking-elapsed')).toHaveText(/^Total [1-9]\d*s$/)
  await expect(status.locator('.thinking-elapsed')).not.toHaveAttribute('title', /./)
  await expect(status.locator('.bubble-thinking-label')).toHaveCSS('animation-name', 'thinking-shimmer')
  await expect(thread.locator('.answer-actions')).toHaveCount(0)
  await screenshot('chat-thinking.png')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(status.locator('.bubble-thinking-label')).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.locator('.bots-write .bubble-stop').click()
  await expect(page.locator('.bots-write .bubble-stop')).toHaveCount(0)
})

test('settings rows share an inset without nested modal padding or a footer', async () => {
  for (const width of [1280, 620]) {
    await page.setViewportSize({ width, height: 720 })
    await navigate('settings')
    // One page with no model rows: the only AI default left is the Test row.
    await expect(page.getByTestId('ai-check-filing')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Filing model', exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'New conversation model', exact: true })).toHaveCount(0)
    await expect(page.locator('.settings-box .dialog-actions')).toHaveCount(0)
    const box = page.locator('.brief-box.settings-box')
    await expect(box).toHaveCSS('padding', '0px')
    await expect(box).toHaveCSS('gap', '0px')
    await expect.poll(() => box.evaluate((node) => {
      const scroll = node.querySelector('.settings-scroll')!
      const inset = (element: Element) => element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft)
      const groups = ['settings-theme', 'settings-shortcut', 'settings-start-fresh', 'settings-about'].map((id) => node.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect())
      const test = node.querySelector('[data-testid="ai-check-filing"]')!.closest('.settings-section')!.getBoundingClientRect()
      return {
        contentAligned: Math.abs(inset(scroll) - groups[0]!.left) <= 1,
        fieldsAligned: groups.every((group) => Math.abs(group.width - test.width) <= 1),
        columnsAligned: groups.every((group) => Math.abs(group.left - test.left) <= 1),
        fitsWidth: test.right <= node.getBoundingClientRect().right,
        fitsHeight: node.getBoundingClientRect().bottom <= innerHeight,
      }
    })).toEqual({ contentAligned: true, fieldsAligned: true, columnsAligned: true, fitsWidth: true, fitsHeight: true })
    await page.keyboard.press('Escape')
  }
})

test('the chat keeps a usable preview card and input instead of clipping at narrow widths', async () => {
  for (const [width, height] of [[1600, 840], [948, 760], [620, 720]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await navigate('bots')
    await expect(page.locator('.mission-tile, .mini-chat')).toHaveCount(0)
    await pageWork()
    await expect.poll(() => page.locator('.bots-chat').evaluate((chat) => {
      const bounds = chat.getBoundingClientRect()
      const preview = chat.querySelector('[data-testid="preview-card"]')!.getBoundingClientRect()
      const input = chat.querySelector('[data-testid="bots-input"]')!.getBoundingClientRect()
      return preview.width >= 140 && preview.left >= bounds.left && preview.right <= bounds.right && preview.bottom <= input.top
        && input.width >= 120 && input.left >= bounds.left && input.right <= bounds.right
        && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight + 1
    })).toBe(true)
    await screenshot(`chat-layout-${width}.png`)
  }
})

test('the draft survives opening and putting away the page and switching chats', async () => {
  for (const width of [2600, 1600, 948, 620]) {
    await page.setViewportSize({ width, height: 840 })
    await navigate('bots')
    for (const index of [0, 1]) await expect(page.getByTestId(`mission-chat-toggle-${index}`)).toHaveCount(0)
    const input = page.getByTestId('bots-input')
    await input.fill('Keep this draft 한글')
    await pageWork()
    await openAndPutAwayPage(width)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Keep this draft 한글')
    // There is no chat picker: another chat is opened from its sidebar row, and each chat keeps its own draft.
    await expect(page.getByTestId('mission-add-menu')).toHaveCount(0)
    if (await page.getByTestId('app-sidebar').isVisible()) {
      await page.locator('.bots-row', { hasText: 'Release planning' }).click()
      await expect(page.getByTestId('bots-input')).toHaveValue('')
      await page.locator('.bots-row', { hasText: 'Research scout' }).click()
      await expect(page.getByTestId('bots-input')).toHaveValue('Keep this draft 한글')
    }
    await page.getByTestId('bots-input').fill('')
  }
  await pageWork()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.preview-deck-card').first()).toHaveCSS('transition-duration', '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByTestId('preview-card').getByRole('button', { name: 'Hide preview', exact: true }).click()
  await expect(page.getByTestId('preview-card')).toHaveCount(0)
})

test('the last answer stays above the composer and its soft scroll edge as the draft grows', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', () => ({ ok: true }))
  })
  await page.setViewportSize({ width: 620, height: 720 })
  await navigate('bots')
  const id = (await page.locator('.bots-row.active').getAttribute('data-testid'))!.replace(/^bot-/, '')
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
    await screenshot(draft ? 'conversation-growing.png' : 'conversation-answer.png')
    await expect.poll(() => page.locator('.bots-thread').evaluate((node) => {
      const answers = node.querySelectorAll('.bubble-msg.assistant')
      const last = answers[answers.length - 1]!.querySelector('p:last-child')!
      const line = last.getBoundingClientRect()
      const thread = node.getBoundingClientRect()
      const composer = node.closest('.bots-chat')!.querySelector('.bots-write')!.getBoundingClientRect()
      return {
        aboveFade: line.bottom <= thread.bottom - 18, aboveComposer: line.bottom < composer.top, insideThread: line.top >= thread.top,
        line: { top: line.top, bottom: line.bottom }, thread: { top: thread.top, bottom: thread.bottom },
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      }
    })).toMatchObject({ aboveFade: true, aboveComposer: true, insideThread: true })
  }
  await screenshot('conversation-compact.png')
  await page.locator('.bots-thread').evaluate((node) => { node.scrollTop = 0 })
  await expect.poll(() => page.locator('.bots-thread').evaluate((node) => node.scrollTop)).toBe(0)
  await input.fill('Reading an earlier answer')
  await expect.poll(() => page.locator('.bots-thread').evaluate((node) => node.scrollTop)).toBe(0)
  await input.fill('')
  await navigate('sky')
  await screenshot('cosmos-compact.png')
})

test('tool activity follows smoothly, readers keep their place, and sending returns to the newest turn', async () => {
  await navigate('bots')
  const thread = page.locator('.bots-thread'), input = page.getByTestId('bots-input')
  await input.fill('Continue with a new task')
  await input.press('Enter')
  // The open conversation's lane, not botsList()[0] (the primary bot, which is not always the one open here).
  const open = page.locator('.bots-row.active, .sidebar-primary-button.active')
  await expect(open).toHaveCount(1)
  const id = (await open.getAttribute('data-testid'))!.replace(/^bot-/, '')
  await expect.poll(() => thread.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2)
  await thread.evaluate(node => {
    const work = document.createElement('ol')
    work.dataset.scrollFixture = 'work'
    work.style.height = '1000px'
    work.textContent = 'Tool activity grew'
    node.append(work)
  })
  await expect.poll(() => thread.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2)
  await thread.evaluate(node => { node.scrollTop = 100 })
  await expect.poll(() => thread.evaluate(node => node.scrollTop)).toBe(100)
  await thread.evaluate(node => { (node.querySelector('[data-scroll-fixture]') as HTMLElement).style.height = '1800px' })
  await expect.poll(() => thread.evaluate(node => node.scrollTop)).toBe(100)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: `bot-${id}`, text: 'The task ended.' }), id)
  await expect(page.locator('.bots-write .bubble-stop')).toHaveCount(0)
  await thread.evaluate(node => { node.scrollTop = 100 })
  await input.fill('One more task')
  await input.press('Enter')
  await expect.poll(() => thread.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: `bot-${id}`, text: 'Finished.' }), id)
  await thread.evaluate(node => node.querySelector('[data-scroll-fixture]')?.remove())
})

test('a long bot list scrolls inside the sidebar and leaves the last bot reachable', async () => {
  await page.evaluate(async () => {
    for (let i = 1; i <= 12; i++) await window.engram.botCreate({ name: `Extra project ${i}`, purpose: '' })
  })
  await page.setViewportSize({ width: 948, height: 720 })
  await navigate('bots')
  await expect(page.getByTestId('mission-add-menu')).toHaveCount(0)
  const sidebar = page.getByTestId('app-sidebar')
  await expect(sidebar.locator('.bots-row[title^="Extra project "]')).toHaveCount(12)
  await expect.poll(() => sidebar.locator('.sidebar-scroll').evaluate((node) => {
    const box = node.getBoundingClientRect()
    return node.scrollHeight > node.clientHeight && box.bottom <= innerHeight && box.left >= 0
  })).toBe(true)
  const [id, name] = await sidebar.locator('.bots-row').last().evaluate((node) => [node.getAttribute('data-testid')!, node.getAttribute('title')!])
  const last = page.getByTestId(id!)
  await last.click()
  await expect(last).toHaveClass(/active/)
  // Its chat opens: the empty state names it, unless an earlier test here already talked to it and left a thread.
  const empty = page.getByTestId('bot-empty')
  await expect(empty.or(page.locator('.bots-thread .bubble-msg').first())).toBeVisible()
  if (await empty.isVisible()) await expect(empty).toContainText(name!)
  await expect(page.getByTestId('bots-input')).toBeEditable()
})
