import { test, expect, _electron as electron } from '@playwright/test'
import { initVault, createBot, appendBotTurn, createTask, updateTask } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

test('split panes show localized approval and choice cards without overflow', async () => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  const paths = await initVault(await mkdtemp(join(root, 'decision-cards-')), { git: false })
  const bot = await createBot(paths, { name: 'Approval fixture' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: '내용 확인해줘', at: new Date().toISOString() })
  const task = await createTask(paths, 'Review content', bot.id)
  await updateTask(paths, task.id, value => {
    value.state = 'waiting'
    value.approvals.push({ id: 'split-approval', words: 'Submit review', url: 'https://example.test/review', host: 'example.test', at: new Date().toISOString() })
  })
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(root, 'decision-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('shell').waitFor({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => window.engram.vaultReady()), { timeout: 60_000 }).toBe(true)
    await page.evaluate(id => localStorage.setItem('engram.mission.slots', JSON.stringify([id, null, null, null])), bot.id)
    await page.reload()
    await page.setViewportSize({ width: 950, height: 900 })
    await page.getByTestId('mission-layout-2').click()
    const tile = page.getByTestId('mission-tile-0')
    const approval = tile.getByTestId('task-approvals')
    await expect(approval).toContainText('진행하기 전에')
    await expect(approval.getByRole('button', { name: '진행해 주세요' })).toBeVisible()
    const command = `Run this command outside the sandbox?\n${'echo safe; '.repeat(30)}Remove-Item report.txt`
    await updateTask(paths, task.id, value => {
      value.state = 'running'
      value.approvals[0]!.words = command
      value.approvals[0]!.url = 'file:///work#command-one'
    })
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'tasks:changed' })
    })
    await expect(approval.locator('.approval-command')).toHaveText(command)
    await expect(approval.getByRole('button', { name: '진행해 주세요' })).toBeEnabled()
    expect(await approval.evaluate(node => !!node.closest('.mini-chat-thread'))).toBe(true)
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'chat:offer', channel: `bot-${id}`, offer: { kind: 'asked', question: 'Which one?', options: ['먼저 확인해줘', '나중에 할게'] } })
    }, bot.id)
    const choices = tile.getByTestId('bots-choices')
    await expect(choices).toContainText('어떻게 할까요?')
    await expect(choices.getByTestId('bots-choice-0')).toBeVisible()
    for (const width of [950, 620]) {
      await page.setViewportSize({ width, height: 900 })
      if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
      await expect(approval.getByRole('button', { name: '진행해 주세요' })).toBeVisible()
      expect(await choices.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await approval.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await approval.getByRole('button', { name: '진행해 주세요' }).scrollIntoViewIfNeeded()
      expect(await approval.getByRole('button', { name: '진행해 주세요' }).evaluate(node => {
        const box = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
    }
    await page.screenshot({ path: join(root, 'release-064-split-cards.png') })
  } finally { await app.close() }
})
