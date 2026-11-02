import { expect, test, _electron as electron, type Locator } from '@playwright/test'
import { appendBotTurn, createBot, createTask, initVault, updateTask } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test('app preview stays inside full, split, minimized and expanded conversations', async () => {
  await mkdir(join(TMP, 'preview-captures'), { recursive: true })
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
    const frames = bots.map((bot, index) => ({ id: `bot-${bot.id}:window:${index}`, lane: `bot-${bot.id}`, title: `Owned app ${index + 1}`, at: Date.now(), captureState: 'ready', current: false,
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=' }))
    await app.evaluate(({ ipcMain }, frames) => {
      ipcMain.removeHandler('desktop:previews')
      ipcMain.handle('desktop:previews', (_event, lane: string) => frames.filter(frame => frame.lane === lane))
    }, frames)
    await page.evaluate(ids => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map(bot => bot.id))
    await page.reload()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bots[0]!.id}`).click()
    const full = page.locator('.bots-chat')
    const preview = full.getByTestId('work-preview')
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Expand app activity' }).click()
    const check = async (chat: Locator, name: string) => {
      const pane = chat.getByTestId('work-preview')
      await expect(pane).toBeVisible()
      await expect(chat.locator('textarea')).toBeVisible()
      const approval = chat.getByTestId('task-approvals').getByRole('button').last()
      await approval.scrollIntoViewIfNeeded()
      await expect(approval).toBeVisible()
      expect(await chat.evaluate(element => {
        const preview = element.querySelector('.work-preview')!.getBoundingClientRect()
        const parent = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll('textarea, .decision-card button, .bubble-msg')]
        return preview.left >= parent.left && preview.right <= parent.right && preview.top >= parent.top && preview.bottom <= parent.bottom
          && controls.every(control => {
            const box = control.getBoundingClientRect()
            return box.bottom <= preview.top || box.top >= preview.bottom || box.right <= preview.left || box.left >= preview.right
          })
      })).toBe(true)
      await page.screenshot({ path: join(TMP, 'preview-captures', `${name}.png`) })
    }
    await check(full, 'full')
    await preview.getByRole('button', { name: 'Collapse app activity' }).click()
    await check(full, 'minimized')
    await preview.getByRole('button', { name: 'Expand app activity' }).click()
    await page.setViewportSize({ width: 1600, height: 1000 })
    await check(full, 'expanded')
    await openActivity(page, 'mission')
    await page.getByTestId('mission-layout-2').click()
    const mini = page.getByTestId(`mini-chat-${bots[0]!.id}`)
    await expect(mini.getByTestId('work-preview')).toBeVisible()
    const expand = mini.getByRole('button', { name: 'Expand app activity' })
    if (await expand.isVisible()) await expand.click()
    await expect(mini).toContainText('Owned app 1')
    await expect(mini).not.toContainText('Owned app 2')
    await check(mini, 'split')
  } finally { await closeTestApp(app) }
})
