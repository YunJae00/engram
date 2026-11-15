import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createBot, createTask, initVault, loadBots, resetBotsToV2, updateTask } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

// qa142: a team bot's sidebar row expands to its leads (name and status), by mouse or keyboard.
test('a team bot row in the sidebar expands to its lead rows', async () => {
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-sidebar-team-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'Team fixture' })).id
  const task = await createTask(paths, 'Plan the offsite', botId)
  const lead = (id: string, role: string, state: 'working' | 'done', parentId: string | null = null) => ({ id, parentId, depth: parentId ? 2 : 1, role, brief: role, state, sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
  await updateTask(paths, task.id, t => { t.state = 'waiting'; t.question = 'Which city?'; t.team = { members: [lead('m1', 'Venue lead', 'working'), lead('m2', 'Venue helper', 'working', 'm1'), lead('m3', 'Budget lead', 'done')], hires: 3, maxHires: 8, maxDepth: 3, big: false } })
  // The primary bot's own button gets the same disclosure.
  const heroId = (await loadBots(paths)).find(bot => bot.primary)!.id
  expect(heroId).not.toBe(botId)
  const heroTask = await createTask(paths, 'Plan the launch', heroId)
  await updateTask(paths, heroTask.id, t => { t.state = 'waiting'; t.question = 'Which day?'; t.team = { members: [lead('h1', 'Launch lead', 'working')], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-sidebar-team-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  const row = page.locator('li.sidebar-item', { has: page.getByTestId(`bot-${botId}`) })
  const toggle = row.getByTestId('sidebar-team-toggle')
  await expect(toggle, 'SIDEBAR-TEAM collapsed by default').toHaveAttribute('aria-expanded', 'false')
  await expect(row.getByTestId('sidebar-team-lead').first()).toBeHidden()
  const rowBox = (await page.getByTestId(`bot-${botId}`).boundingBox())!, toggleBox = (await toggle.boundingBox())!
  expect(toggleBox.y, 'SIDEBAR-TEAM sits under the row').toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1)
  expect(toggleBox.x + toggleBox.width, 'SIDEBAR-TEAM stays inside the row width').toBeLessThanOrEqual(rowBox.x + rowBox.width + 40)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle, 'SIDEBAR-TEAM opens from the keyboard').toHaveAttribute('aria-expanded', 'true')
  await expect(row.getByTestId('sidebar-team-lead'), 'SIDEBAR-TEAM leads only, name and status').toHaveText([/Venue lead.+/, /Budget lead.+/])
  await expect(row.getByTestId('sidebar-team-lead').first()).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const heroToggle = page.locator('.sidebar-primary').getByTestId('sidebar-team-toggle')
  await expect(heroToggle, 'SIDEBAR-TEAM primary collapsed by default').toHaveAttribute('aria-expanded', 'false')
  expect((await heroToggle.boundingBox())!.y, 'SIDEBAR-TEAM primary disclosure sits under its button').toBeGreaterThanOrEqual((b => b.y + b.height - 1)((await page.getByTestId(`bot-${heroId}`).boundingBox())!))
  await heroToggle.click()
  await expect(page.locator('.sidebar-primary').getByTestId('sidebar-team-lead'), 'SIDEBAR-TEAM primary leads').toHaveText([/Launch lead.+/])
})

// qa143 S19 (c): after a limit-stop, and after the "continue" that followed, the bot's team tree and in-chat team card were gone.
test('a bot keeps its last team in the sidebar and the chat after the task stopped at a limit', async () => {
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-sidebar-team-ended-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'Launch fixture' })).id
  const task = await createTask(paths, '신제품 출시 준비', botId)
  const lead = (id: string, role: string) => ({ id, parentId: null, depth: 1, role, brief: role, state: 'released' as const, result: '끝냈어요', sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
  await updateTask(paths, task.id, t => { t.state = 'failed'; t.team = { members: [lead('m1', '시장조사 팀장'), lead('m2', '마케팅 팀장')], hires: 2, maxHires: 8, maxDepth: 3, big: false } })
  const next = await createTask(paths, '이어서 해줘', botId)
  await updateTask(paths, next.id, t => { t.state = 'done'; t.result = '끝' })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-sidebar-team-ended-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  const row = page.locator('li.sidebar-item', { has: page.getByTestId(`bot-${botId}`) })
  const toggle = row.getByTestId('sidebar-team-toggle')
  await expect(toggle, 'ENDED-TEAM stays under the bot row').toBeVisible()
  await toggle.click()
  await expect(row.getByTestId('sidebar-team-lead'), 'ENDED-TEAM leads and how they finished').toHaveText([/시장조사 팀장.+/, /마케팅 팀장.+/])
  await expect(row.getByTestId('sidebar-team-lead').first()).toHaveAttribute('data-state', 'released')
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.getByTestId('team-card'), 'ENDED-TEAM card stays in the chat').toBeVisible()
})
