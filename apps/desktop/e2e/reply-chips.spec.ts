import { test, expect, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('completed replies show no suggestion chips, hide their markup, and the follow-up is sent only when the person types it', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'reply-vault-')), { git: false })
  await resetBotsToV2(paths)
  const at = new Date().toISOString()
  const supplied = await createBot(paths, { name: 'Suggested follow-ups' })
  const fallback = await createBot(paths, { name: 'Missing suggestions' })
  for (const bot of [supplied, fallback]) await appendBotTurn(paths, bot.id, { role: 'user', text: 'Find some options.', at })
  await appendBotTurn(paths, supplied.id, { role: 'assistant', text: 'Here are the results.\n\n| Item | Status | Link |\n| --- | --- | --- |\n| Example | Open | https://example.com |\n\n```replies\nShow more options\nCompare these options\n```', at })
  await appendBotTurn(paths, fallback.id, { role: 'assistant', text: '결과를 찾았어요.', at })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'reply-data-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId(`bot-${supplied.id}`)).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      const captured = globalThis as typeof globalThis & { replyMessages?: string[] }
      captured.replyMessages = []
      ipcMain.removeHandler('chat:send')
      ipcMain.handle('chat:send', (_event, request: { message: string }) => { captured.replyMessages!.push(request.message) })
    })
    await page.getByTestId(`bot-${supplied.id}`).click()
    const chips = page.locator('[data-testid="reply-chips"], [data-testid^="reply-chip-"]')
    await expect(page.locator('.bubble-msg.assistant').first()).toContainText('Here are the results.')
    await expect(chips).toHaveCount(0)
    await expect(page.getByTestId('bots-thread')).not.toContainText('Show more options')
    await expect(page.locator('.answer-card')).toHaveCount(1)
    await expect(page.locator('.bubble-msg.assistant')).toHaveCount(2)
    await expect(page.locator('.bubble-msg.assistant').first()).toHaveText('Here are the results.')
    await expect(page.locator('.bubble-msg.assistant').last()).toContainText('Example')
    await expect(page.locator('.bubble-msg.assistant').locator('h2, hr')).toHaveCount(0)
    await expect(page.getByTestId('bots-thread')).not.toContainText('```replies')
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { replyMessages: string[] }).replyMessages)).toEqual([])
    await page.getByTestId('bots-input').fill('Show more options')
    await page.getByTestId('bots-input').press('Enter')
    await expect(page.locator('.bubble-msg.user').last()).toHaveText('Show more options')
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { replyMessages: string[] }).replyMessages)).toEqual(['Show more options'])
    await page.getByTestId(`bot-${fallback.id}`).click()
    await expect(page.locator('.bubble-msg.assistant')).toHaveText(['결과를 찾았어요.'])
    await expect(chips).toHaveCount(0)
    await expect(page.getByTestId('bots-thread')).not.toContainText('좀 더 자세히 알려줘')
    await page.setViewportSize({ width: 780, height: 700 })
    await page.getByTestId('app-sidebar-close').click()
    await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
    await expect(chips).toHaveCount(0)
    await expect(page.getByTestId('bots-input')).toBeVisible()
    const shot = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
      await window.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 400))
      return (await window.webContents.capturePage()).toPNG().toString('base64')
    })
    await writeFile(join(tmp, 'release-061-replies.png'), Buffer.from(shot, 'base64'))
  } finally { await app.close() }
})

test('an unanswered later turn or a partial progress tail shows no reply chips from the earlier answer', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'reply-vault-')), { git: false })
  await resetBotsToV2(paths)
  const at = new Date().toISOString()
  const answered = '```replies\n이 중 2개만 골라줘\n다른 요일/시간대로 다시 뽑아줘\n```'
  const interrupted = await createBot(paths, { name: 'Interrupted turn' })
  const partial = await createBot(paths, { name: 'Partial progress' })
  for (const bot of [interrupted, partial]) {
    await appendBotTurn(paths, bot.id, { role: 'user', text: '민지랑 회의 시간 잡아줘', at })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: `후보를 뽑았어요.\n\n${answered}`, at })
  }
  await appendBotTurn(paths, interrupted.id, { role: 'user', text: '그때까지 뭘 준비하면 좋을까?', at })
  await appendBotTurn(paths, partial.id, { role: 'user', text: '하나 더 찾아줘', at })
  await appendBotTurn(paths, partial.id, { role: 'assistant', text: `찾는 중이에요.\n\n${answered}`, progress: true, at })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'reply-data-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTestId(`bot-${interrupted.id}`).click()
    await expect(page.locator('.bubble-msg.user').last()).toHaveText('그때까지 뭘 준비하면 좋을까?')
    await expect(page.locator('.bubble-msg.assistant')).toHaveCount(1)
    await expect(page.locator('[data-testid="reply-chips"], [data-testid^="reply-chip-"]')).toHaveCount(0)
    await page.getByTestId(`bot-${partial.id}`).click()
    await expect(page.locator('.bubble-msg.user').last()).toHaveText('하나 더 찾아줘')
    await expect(page.getByTestId('bots-thread')).toContainText('찾는 중이에요.')
    await expect(page.locator('[data-testid="reply-chips"], [data-testid^="reply-chip-"]')).toHaveCount(0)
  } finally { await app.close() }
})
