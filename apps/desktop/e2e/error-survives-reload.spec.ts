import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createBot, initVault, readBotTranscript, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

// qa142 B2 follow-up: a provider error that is not an outage left nothing in the saved thread.
test('a failed answer is still an error card after a reload, in the thread language, with no continue chip', async () => {
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-error-reload-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'Error fixture' })).id
  // A mock engine with no canned answer fails every call with a plain provider error.
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-error-reload-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: await mkdtemp(join(tmp, 'e2e-error-reload-mock-')), ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${botId}`).click()
  const input = page.getByTestId('bots-input')
  await input.fill('회의록을 정리해 주세요'); await input.press('Enter')
  const card = page.locator('.bots-view .bubble-msg.assistant.error')
  await expect(card, 'ERROR-RELOAD shown live').toHaveCount(1, { timeout: 30_000 })
  await expect.poll(async () => (await readBotTranscript(paths, botId)).map(turn => [turn.role, !!turn.error]), { message: 'ERROR-RELOAD saved once' }).toEqual([['user', false], ['assistant', true]])
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  if (await page.getByTestId('app-sidebar-open').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.locator('.bots-view .bubble-msg.user')).toHaveText(['회의록을 정리해 주세요'])
  await expect(card, 'ERROR-RELOAD still there').toHaveCount(1)
  await expect(card, 'ERROR-RELOAD localized').toContainText('요청을 끝내지 못했어요')
  await expect(page.locator('.bots-view'), 'ERROR-RELOAD no continue note or chip').not.toContainText('이어서 해줘')
})
