import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createBot, createTask, initVault, resetBotsToV2, updateTask } from 'core'
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
})
