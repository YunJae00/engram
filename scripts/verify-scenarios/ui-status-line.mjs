import { appendBotTurn, createBot } from '../../packages/core/src/index.ts'

export async function run(page, { app, paths, expect, openActivity }) {
  const bot = await createBot(paths, { name: 'Status line fixture' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'What is the status?', at: new Date().toISOString() })
  await page.reload()
  await openActivity(page, 'bots')
  await page.getByTestId(`bot-${bot.id}`).click()

  const thread = page.getByTestId('bots-thread')
  await expect(thread).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    globalThis.statusLineFixture = { original: ipcMain._invokeHandlers.get('chat:send') }
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', (_event, request) => new Promise(resolve => {
      Object.assign(globalThis.statusLineFixture, { request, release: resolve })
    }))
  })
  try {
    const question = 'Check the status line.'
    await page.getByTestId('bots-input').fill(question)
    await page.getByTestId('bots-input-send').click()
    await expect.poll(() => app.evaluate(() => globalThis.statusLineFixture.request?.message)).toBe(question)
    await app.evaluate(({ BrowserWindow }, event) => {
      BrowserWindow.getAllWindows()[0].webContents.send('engram:event', event)
    }, { type: 'comet:step', channel: `bot-${bot.id}`, line: 'task_plan: checking status' })

    const status = thread.getByTestId('bots-thinking')
    await expect(status).toBeVisible()
    await expect(status).toHaveAttribute('role', 'status')
    const evidence = []
    for (const width of [1280, 720]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(600, 560)
        window.setSize(size, 800)
      }, width)
      await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async value => {
          const settings = await globalThis.window.engram.settingsGet()
          await globalThis.window.engram.settingsSet({ ...settings, theme: value })
        }, theme)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(status).toBeVisible()
        evidence.push(await status.evaluate(element => {
          const threadElement = element.closest('[data-testid="bots-thread"]')
          const bubbleSelector = '.bubble-msg, .bubble-typing, .comet-work-line.said'
          const ancestors = []
          for (let node = element; node && node !== threadElement; node = node.parentElement) {
            const style = globalThis.getComputedStyle(node)
            const padding = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
            const background = style.backgroundColor
            const hasBackground = background !== 'transparent' && !/^rgba?\([^)]*,\s*0(?:\.0+)?\)$/.test(background)
            const hasPadding = padding.some(value => parseFloat(value) >= 6)
            ancestors.push({
              element: node.className || node.tagName.toLowerCase(),
              background,
              radius: style.borderRadius,
              padding: style.padding,
              bubbleClass: node.matches(bubbleSelector),
              bubbleStyle: hasBackground || hasPadding,
            })
          }
          const nearest = ancestors[1] ?? ancestors[0]
          return {
            background: nearest.background,
            radius: nearest.radius,
            padding: nearest.padding,
            nearestContainer: nearest.element,
            insideBubble: ancestors.some(node => node.bubbleClass),
            violations: ancestors.filter(node => node.bubbleClass || node.bubbleStyle),
          }
        }).then(measurement => ({ width, theme, ...measurement })))
      }
    }
    return { ok: evidence.length === 4 && evidence.every(entry => !entry.insideBubble && entry.violations.length === 0), evidence }
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.statusLineFixture.release?.()
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', globalThis.statusLineFixture.original)
      delete globalThis.statusLineFixture
    })
  }
}
