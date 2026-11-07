import { expect, test, _electron as electron, type Locator } from '@playwright/test'
import { appendBotTurn, createBot, createTask, initVault, updateTask } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test('app previews stack, promote back cards and stay inside full, split, minimized and expanded conversations', async () => {
  await mkdir(join(TMP, 'preview-captures-109'), { recursive: true })
  const paths = await initVault(await mkdtemp(join(TMP, 'preview-layout-')), { git: false })
  const bots = await Promise.all(['Preview one', 'Preview two'].map(name => createBot(paths, { name })))
  for (const bot of bots) {
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'The local app read is ready for review.', at: new Date().toISOString() })
    const task = await createTask(paths, 'Review local app', bot.id)
    await updateTask(paths, task.id, value => {
      value.state = 'waiting'
      value.approvals.push({ id: `approval-${bot.id}`, words: 'Confirm local action', url: 'https://example.test/review', host: 'example.test', at: new Date().toISOString() })
    })
  }
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    const size = { width: 1280, height: 720 }
    const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toDataURL(), size)
    const frames = bots.map((bot, index) => ({ id: `bot-${bot.id}:window:${index}`, lane: `bot-${bot.id}`, title: `Owned app ${index + 1}`, at: Date.now(), captureState: 'ready', current: false, data }))
    await app.evaluate(({ ipcMain }, frames) => {
      ipcMain.removeHandler('desktop:previews')
      ipcMain.handle('desktop:previews', (_event, lane: string) => frames.filter(frame => frame.lane === lane))
      ipcMain.removeHandler('native:enabled')
      ipcMain.handle('native:enabled', () => false)
    }, frames)
    await page.evaluate(ids => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map(bot => bot.id))
    await page.reload()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bots[0]!.id}`).click()
    const full = page.locator('.bots-chat')
    const preview = full.getByTestId('preview-card')
    await expect(preview).toBeVisible()
    await expect(full.getByTestId('task-approvals')).toBeVisible()
    const check = async (chat: Locator, name: string) => {
      const pane = chat.locator('[data-testid=preview-card], [data-testid=preview-card-collapsed]')
      await expect(pane).toBeVisible()
      await expect(chat.locator('textarea')).toBeVisible()
      const approval = chat.getByTestId('task-approvals').getByRole('button').last()
      await approval.scrollIntoViewIfNeeded()
      await expect(approval).toBeVisible()
      await expect.poll(() => chat.evaluate(element => {
        const preview = element.querySelector('.preview-card, [data-testid=preview-card-collapsed]')!.getBoundingClientRect()
        const parent = element.getBoundingClientRect()
        const thread = element.querySelector('.conversation-thread')!.getBoundingClientRect()
        if (preview.right > innerWidth || preview.bottom > innerHeight) return false
        const input = element.querySelector('textarea')!.getBoundingClientRect()
        if (input.top < parent.top || input.bottom > parent.bottom) return false
        const controls = [...element.querySelectorAll('textarea, .decision-card button, .bubble-msg')]
        return preview.left >= parent.left && preview.right <= parent.right && preview.top >= parent.top && preview.bottom <= parent.bottom
          && preview.bottom <= thread.top + 1 && controls.every(control => {
            const box = control.getBoundingClientRect()
            const inThread = !!control.closest('.conversation-thread')
            const top = inThread ? Math.max(box.top, thread.top) : box.top
            const bottom = inThread ? Math.min(box.bottom, thread.bottom) : box.bottom
            if (bottom <= top) return true
            return bottom <= preview.top || top >= preview.bottom || box.right <= preview.left || box.left >= preview.right
          })
      })).toBe(true)
      const image = await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
        await window.webContents.capturePage()
        await new Promise(resolve => setTimeout(resolve, 400))
        return (await window.webContents.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(TMP, 'preview-captures-109', `${name}.png`), Buffer.from(image, 'base64'))
    }
    const emit = async (events: unknown[]) => app.evaluate(({ BrowserWindow }, events) => {
      const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
      for (const event of events) window.webContents.send('engram:event', event)
    }, events)
    const lane = `bot-${bots[0]!.id}`
    const web = { type: 'agent:frame', lane, url: 'https://example.test/preview', data: data.split(',')[1], ...size }
    const expand = async () => {
      const button = full.getByTestId('preview-card-collapsed')
      if (await button.isVisible()) await button.click()
    }
    const promote = async (name: string) => {
      const back = full.getByTestId('preview-deck').getByRole('button', { name, exact: true })
      await expect.poll(() => back.locator('..').evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform)
        return { rotated: Math.abs(matrix.b) >= 0.02, offset: matrix.e <= -20, raised: matrix.f <= -20 }
      })).toEqual({ rotated: false, offset: true, raised: true })
      const front = await full.getByTestId('preview-deck').locator('[data-position="0"]').boundingBox()
      const behind = await back.boundingBox()
      expect(front!.y - behind!.y).toBeGreaterThanOrEqual(20)
      expect(front!.x - behind!.x).toBeGreaterThanOrEqual(20)
      await expect(back.locator('.preview-deck-title')).toBeVisible()
      const exposed = () => back.evaluate(element => {
        const box = element.getBoundingClientRect()
        for (let y = box.top + 2; y < box.top + 24; y += 2) for (let x = box.left + 8; x < box.right - 8; x += 8) {
          if (element.contains(document.elementFromPoint(x, y))) return { x, y }
        }
        return null
      })
      await expect.poll(exposed).not.toBeNull()
      const point = (await exposed())!
      await page.mouse.click(point.x, point.y)
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
      await emit([{ type: 'desktop:preview', frames }, { type: 'comet:working', channel: lane, working: true }])
      await expand()
      await expect(preview.locator('.preview-card-stage')).toBeVisible()
      await expect(preview.locator('.preview-card-caption')).toHaveCSS('color', 'rgb(255, 255, 255)')
      await expect(preview.locator('.preview-card-actions button').first()).toHaveCSS('color', 'rgb(255, 255, 255)')
      await check(full, `${theme}-app-only`)
      await page.getByTestId('bots-input').fill('Keep this draft focused')
      await emit([{ type: 'desktop:preview', frames }, { type: 'comet:working', channel: lane, working: true }, { type: 'comet:step', channel: lane, line: 'read_open_page: Preview' }, web])
      await expect(page.getByTestId('bots-input')).toBeFocused()
      await expand()
      await expect(full.getByTestId('preview-deck').locator('[data-position]')).toHaveCount(2)
      const metrics = () => preview.evaluate(element => {
        const style = getComputedStyle(element), stage = element.querySelector('.preview-card-stage')!
        return { width: element.getBoundingClientRect().width, headers: element.querySelectorAll('.preview-card-bar').length,
          radius: style.borderRadius, shadow: style.boxShadow, background: style.backgroundColor, aspect: getComputedStyle(stage).aspectRatio }
      })
      await promote('Owned app 1')
      await expect(full.getByTestId('preview-deck').locator('[data-position="0"]')).toHaveAttribute('data-frame', frames[0]!.id)
      await expect.poll(async () => (await metrics()).width).toBe(320)
      const appStyle = await metrics()
      await promote('example.test')
      await expect(preview.locator('canvas')).toHaveAttribute('data-painted', '')
      await page.getByTestId('bots-input').fill('Still focused after a painted web frame')
      await emit([web])
      await expect(page.getByTestId('bots-input')).toBeFocused()
      await expect.poll(metrics).toEqual(appStyle)
      expect(appStyle.width).toBe(320)
      expect(appStyle.headers).toBe(0)
      expect(appStyle.radius).toBe('16px')
      const [w, h = '1'] = appStyle.aspect.split('/').map(part => part.trim())
      expect(Math.abs(Number(w) / Number(h) / (size.width / size.height) - 1)).toBeLessThanOrEqual(0.03)
      await check(full, `${theme}-mixed`)
      await full.getByTestId('preview-deck').getByRole('button', { name: 'Owned app 1', exact: true }).press('Enter')
      await full.getByTestId('preview-deck').press('ArrowRight')
      await expect(full.getByTestId('preview-deck').locator('[data-position="0"]')).toHaveAttribute('data-frame', `${lane}:web:https://example.test/preview`)
      await emit([{ type: 'desktop:preview', frames: [] }])
      await check(full, `${theme}-web-only`)
      await emit([{ type: 'desktop:preview', frames }])
      await expect(full.getByTestId('preview-deck').locator('[data-position]')).toHaveCount(2)
      for (const width of [620, 948, 1400]) {
        await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 500); win.setSize(width, 600) }, width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect.poll(() => page.evaluate(() => innerHeight)).toBe(600)
        if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
        await check(full, `${theme}-width-${width}`)
      }
      await preview.getByRole('button', { name: 'Collapse preview' }).click()
      await emit([{ type: 'desktop:preview', frames }])
      await expect(full.getByTestId('preview-card-collapsed')).toBeVisible()
      await expect(preview.locator('canvas, img')).toHaveCount(0)
      await check(full, `${theme}-collapsed`)
      await full.getByTestId('preview-card-collapsed').click()
      await preview.hover()
      await preview.getByRole('button', { name: 'Hide preview' }).click()
      await emit([web, { type: 'desktop:preview', frames }, { type: 'comet:working', channel: lane, working: false }])
      await page.waitForTimeout(100)
      await emit([{ type: 'comet:working', channel: lane, working: true }])
      await expect(preview).toHaveCount(0)
      await expect(page.getByTestId('preview-card-reopen')).toBeVisible()
      const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!.webContents.capturePage()).toPNG().toString('base64'))
      await writeFile(join(TMP, 'preview-captures-109', `${theme}-hidden.png`), Buffer.from(shot, 'base64'))
      await page.getByTestId('preview-card-reopen').click()
      await expect(preview).toBeVisible()
      await emit([{ type: 'comet:working', channel: lane, working: true }])
      await expect(page.getByTestId('bots-input')).toBeVisible()
      await page.waitForTimeout(100)
      await emit([{ type: 'comet:working', channel: lane, working: false }])
      await expect(preview).toBeVisible()
      await expect(preview).toContainText('Last snapshot')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
      await openActivity(page, 'mission')
      await page.getByTestId('mission-layout-2').click()
      const mini = page.getByTestId(`mini-chat-${bots[0]!.id}`)
      await expect(mini.locator('[data-testid=preview-card], [data-testid=preview-card-collapsed]')).toBeVisible()
      await expect(mini.getByTestId('task-approvals')).toBeVisible()
      await emit([{ type: 'comet:working', channel: lane, working: true }])
      const button = mini.getByTestId('preview-card-collapsed')
      if (await button.isVisible()) await button.click()
      await expect(mini).toContainText('Owned app 1')
      await expect(mini).not.toContainText('Owned app 2')
      await check(mini, `${theme}-split`)
      await emit([{ type: 'press:ask', channel: lane, words: 'Confirm local action', host: 'example.test' }])
      await expect(mini.getByTestId('preview-card')).toBeVisible()
      for (const width of [620, 948, 1400]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 600), width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect.poll(() => page.evaluate(() => innerHeight)).toBe(600)
        if (width <= 900 && await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
        await check(mini, `${theme}-split-width-${width}`)
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
      await openActivity(page, 'bots')
      await emit([{ type: 'chat:done', channel: lane, text: 'Preview complete.' }])
      // A folded web lane makes the next theme start with app frames only.
      await page.getByTestId('bots-input-add').click()
      await page.getByTestId('composer-web').click()
    }
  } finally { await closeTestApp(app) }
})
