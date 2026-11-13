import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createBot, initVault, readBotTranscript, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

test('a message sent mid-answer gets its own reply', async () => {
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-followup-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'Follow-up fixture' })).id
  const mock = await mkdtemp(join(tmp, 'e2e-followup-mock-'))
  await writeFile(join(mock, 'default.md'), 'Answer for {{task}}.')
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-followup-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: mock, ENGRAM_TEST_MOCK_GAP_MS: '300', ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${botId}`).click()
  const input = page.getByTestId('bots-input')
  const first = 'Count to five', second = 'What is 3 times 7'
  await input.fill(first); await input.press('Enter')
  await expect(page.locator('.bubble-stop')).toBeVisible()
  await input.fill(second); await input.press('Enter')
  const replies = async () => (await readBotTranscript(paths, botId)).filter(turn => turn.role === 'assistant' && !turn.progress)
  await expect.poll(async () => (await replies()).length, { message: 'MIDSTREAM-FOLLOWUP one reply per message', timeout: 30_000 }).toBe(2)
  await expect(page.locator('.bubble-stop'), 'MIDSTREAM-FOLLOWUP settled').toHaveCount(0, { timeout: 15_000 })
  const users = (await readBotTranscript(paths, botId)).filter(turn => turn.role === 'user' && !turn.progress).map(turn => turn.text)
  expect(users, 'MIDSTREAM-FOLLOWUP user row once').toEqual([first, second])
  const view = page.locator('.bots-view')
  await expect(view.locator('.bubble-msg.user'), 'MIDSTREAM-FOLLOWUP user bubbles').toHaveText([first, second])
  const secondAnswer = `Answer for ${second}`
  await expect(view.locator('.bubble-msg.assistant', { hasText: secondAnswer }), 'MIDSTREAM-FOLLOWUP one separate reply').toHaveCount(1)
  const order = await view.locator('.bubble-msg').evaluateAll(nodes => nodes.map(node => ({ user: node.classList.contains('user'), text: (node as HTMLElement).innerText })))
  const askedAt = order.findIndex(bubble => bubble.user && bubble.text.includes(second))
  const answeredAt = order.findIndex(bubble => !bubble.user && bubble.text.includes(secondAnswer))
  expect(answeredAt, `MIDSTREAM-FOLLOWUP reply after message: ${JSON.stringify(order)}`).toBeGreaterThan(askedAt)
  const firstBubbles = order.filter(bubble => !bubble.user && bubble.text.includes(`Answer for ${first}`))
  expect(firstBubbles.length, `MIDSTREAM-FOLLOWUP first answer shown: ${JSON.stringify(order)}`).toBeGreaterThan(0)
  for (const bubble of firstBubbles) expect(bubble.text, 'MIDSTREAM-FOLLOWUP not glued').not.toContain(secondAnswer)
})
