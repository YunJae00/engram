import { appendBotTurn, createBot, readBotTranscript } from '../../packages/core/src/index.ts'

export async function run(page, { app, paths, expect, openActivity }) {
  const work = ['page_do: historical web edit', 'press: historical click Save', '<- historical tool output', 'Edit: historical.txt']
  const spoken = ['said: I found the page.', 'you: Keep the heading.']
  const bot = await createBot(paths, { name: 'Activity fixture' })
  const append = turn => appendBotTurn(paths, bot.id, { ...turn, at: new Date().toISOString() })
  await append({ role: 'user', text: 'Update the page.' })
  await append({ role: 'assistant', text: 'The page is updated.', work: [...work, ...spoken] })
  await page.reload()
  await openActivity(page, 'bots')
  await page.getByTestId(`bot-${bot.id}`).click()
  const thread = page.getByTestId('bots-thread')
  const status = thread.getByRole('status')
  const noCards = async () => {
    await expect(thread.locator('.comet-work-card, [data-testid="comet-work-toggle"], [data-testid="bots-work-steps"]')).toHaveCount(0)
    for (const line of work) await expect(thread).not.toContainText(line)
  }
  const preservedText = async () => {
    for (const text of ['Update the page.', 'The page is updated.', 'I found the page.', 'Keep the heading.']) await expect(thread).toContainText(text)
  }
  await preservedText()
  await noCards()
  await expect(status).toHaveCount(0)
  const evidence = [{ state: 'persisted history', toolsHidden: true, textPreserved: true }]
  await app.evaluate(({ ipcMain }) => {
    globalThis.activityFixture = { original: ipcMain._invokeHandlers.get('chat:send'), calls: 0 }
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', (_event, request) => new Promise(resolve => {
      Object.assign(globalThis.activityFixture, { request, release: resolve, calls: globalThis.activityFixture.calls + 1 })
    }))
  })
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion })
      const question = `Check again with ${reducedMotion}.`
      await page.getByTestId('bots-input').fill(question)
      await page.getByTestId('bots-input-send').click()
      await expect.poll(() => app.evaluate(() => globalThis.activityFixture.request?.message)).toBe(question)
      await expect(status).toHaveCount(1)
      await expect(status).toBeVisible()
      await expect(status).toHaveAttribute('aria-label', /.+/)
      const initialLabel = await status.getAttribute('aria-label')
      const liveWork = []
      for (const [line, label] of [['page_do: current web edit', 'Working through the page'], ['task_plan: current plan', 'Planning the steps']]) {
        liveWork.push(line)
        await app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('engram:event', event), { type: 'comet:step', channel: `bot-${bot.id}`, line })
        await expect(status).toHaveCount(1)
        await expect(status).toHaveAttribute('aria-label', label)
        expect(label).not.toBe(initialLabel)
        await expect(thread.getByTestId('bots-thinking')).toHaveCount(1)
        await expect(thread.getByTestId('bots-typing')).toHaveCount(1)
        await noCards()
        await preservedText()
      }
      if (reducedMotion === 'reduce') {
        for (const element of await status.locator('.bubble-dots i, .bubble-thinking-label').all()) await expect(element).toHaveCSS('animation-name', 'none')
        await expect(thread.getByTestId('bots-typing')).toHaveCSS('animation-name', 'none')
      }
      const answer = `Checked with ${reducedMotion}.`
      await append({ role: 'user', text: question })
      await append({ role: 'assistant', text: answer, work: liveWork })
      await app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('engram:event', event), { type: 'chat:done', channel: `bot-${bot.id}`, text: answer })
      await expect(status).toHaveCount(0)
      await expect(thread).toContainText(answer)
      await noCards()
      await app.evaluate(() => { globalThis.activityFixture.release(); delete globalThis.activityFixture.request })
      await page.reload()
      await openActivity(page, 'bots')
      await page.getByTestId(`bot-${bot.id}`).click()
      await expect(thread).toBeVisible()
      await expect(thread).toContainText(question)
      await expect(thread).toContainText(answer)
      await preservedText()
      await noCards()
      await expect(status).toHaveCount(0)
      await expect(thread).not.toContainText('Planning the steps')
      evidence.push({ reducedMotion, singleEvolvingStatus: true, clearedOnDoneAndReload: true })
    }
    expect(await app.evaluate(() => globalThis.activityFixture.calls)).toBe(2)
    expect((await readBotTranscript(paths, bot.id))[1].work).toEqual([...work, ...spoken])
    return { ok: true, evidence }
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.activityFixture.release?.()
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', globalThis.activityFixture.original)
      delete globalThis.activityFixture
    })
  }
}
