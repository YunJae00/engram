import { test, expect, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('completed replies show suggestions, hide their markup and send only after an explicit click', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'reply-vault-')), { git: false })
  const at = new Date().toISOString()
  const supplied = await createBot(paths, { name: 'Suggested follow-ups' })
  const fallback = await createBot(paths, { name: 'Missing suggestions' })
  for (const bot of [supplied, fallback]) await appendBotTurn(paths, bot.id, { role: 'user', text: 'Find some options.', at })
  await appendBotTurn(paths, supplied.id, { role: 'assistant', text: 'Here are the results.\n---\n| Item | Status | Link |\n| --- | --- | --- |\n| Example | Open | https://example.com |\n\n```replies\nShow more options\nCompare these options\n```', at })
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
    await expect(page.getByTestId('reply-chip-0')).toHaveText('Show more options')
    await expect(page.locator('.answer-card')).toHaveCount(1)
    await expect(page.locator('.bubble-msg.assistant')).toHaveCount(2)
    await expect(page.locator('.bubble-msg.assistant')).not.toContainText('```replies')
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { replyMessages: string[] }).replyMessages)).toEqual([])
    await page.getByTestId('reply-chip-0').click()
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { replyMessages: string[] }).replyMessages)).toEqual(['Show more options'])
    await page.getByTestId(`bot-${fallback.id}`).click()
    await expect(page.getByTestId('reply-chips').getByRole('button')).toHaveCount(2)
    await expect(page.getByTestId('reply-chip-0')).toHaveText('좀 더 자세히 알려줘')
    await page.setViewportSize({ width: 780, height: 700 })
    await page.getByTestId('app-sidebar-close').click()
    await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
    await expect(page.getByTestId('reply-chip-0')).toBeVisible()
    await page.screenshot({ path: join(tmp, 'release-060-replies.png') })
  } finally { await app.close() }
})
