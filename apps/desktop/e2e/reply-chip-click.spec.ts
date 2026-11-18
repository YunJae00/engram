import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFER = '고객사 답변 오면 다시 알려줄게'
type Fixture = typeof globalThis & { pending: { request: { message: string; channel: string }; resolve(): void }[]; requests: string[] }

let app: ElectronApplication, page: Page, botId: string
test.beforeEach(async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-chip-click-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  botId = (await createBot(paths, { name: 'Chip click fixture' })).id
  const at = new Date().toISOString()
  await appendBotTurn(paths, botId, { role: 'user', text: '다음 회의 리마인더 하나 만들어줘.', at })
  await appendBotTurn(paths, botId, { role: 'assistant', text: `언제로 잡을지 시간이 필요해요. 몇 시로 할까요?\n\n\`\`\`replies\n${DEFER}\n좀 더 자세히 알려줘\n\`\`\``, at })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-chip-click-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    const fixture = globalThis as Fixture
    fixture.pending = []; fixture.requests = []
    for (const channel of ['chat:send', 'chat:active', 'chat:say']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => [])
    ipcMain.handle('chat:send', (_event, request) => new Promise<void>(resolve => { fixture.requests.push(request.message); fixture.pending.push({ request, resolve }) }))
    ipcMain.handle('chat:say', () => ({ ok: false }))
  })
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.locator('.bubble-msg.assistant').last()).toContainText('몇 시로 할까요?')
  await expect(chips()).toHaveCount(0)
  await turnsRendered()
})
test.afterEach(async () => { await app?.close() })

async function requests() { return app.evaluate(() => (globalThis as Fixture).requests) }
async function broadcast(event: Record<string, unknown>) {
  await app.evaluate(({ BrowserWindow }, payload) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', payload) }, event)
}
async function resolveFirst() { await app.evaluate(() => (globalThis as Fixture).pending.shift()!.resolve()) }
async function done(text: string) { await broadcast({ type: 'chat:done', channel: `bot-${botId}`, text }) }
const userBubbles = () => page.locator('.bubble-msg.user')
const chips = () => page.locator('[data-testid="reply-chips"], [data-testid^="reply-chip-"]')
async function say(text: string) { const input = page.getByTestId('bots-input'); await input.fill(text); await input.press('Enter') }
async function turnsRendered() {
  await expect.poll(() => page.evaluate(() => {
    const inner = [...document.querySelectorAll<HTMLElement>('.bots-thread .bubble-turn > *')]
    return inner.length > 0 && inner.every(el => el.checkVisibility({ contentVisibilityAuto: true }))
  }), { message: 'thread turns rendered' }).toBe(true)
}

test('no chip sits under the answer: the defer words typed in the box are sent once', async () => {
  await expect(chips()).toHaveCount(0)
  await expect(page.getByTestId('bots-thread')).not.toContainText(DEFER)
  await say(DEFER)
  await expect.poll(requests).toEqual([DEFER])
  await expect(userBubbles().last()).toHaveText(DEFER)
  await expect(userBubbles().filter({ hasText: DEFER })).toHaveCount(1)
  await page.waitForTimeout(500)
  expect(await requests()).toEqual([DEFER])
})

test('a reply typed while the previous chat:send is unresolved shows at once and is sent once, even after a reload', async () => {
  await say(DEFER)
  await expect.poll(requests).toEqual([DEFER])
  await done('Done.\n\n```replies\nA\nB\n```')
  await expect(page.locator('.bubble-msg.assistant').last()).toContainText('Done.')
  await expect(chips()).toHaveCount(0)
  await say('A')
  await expect(userBubbles().last()).toHaveText('A')
  expect(await requests()).toEqual([DEFER])
  await broadcast({ type: 'errand:logged' })
  await expect(userBubbles().filter({ hasText: /^A$/ })).toHaveCount(0)
  await resolveFirst()
  await expect.poll(requests).toEqual([DEFER, 'A'])
  await expect(userBubbles().filter({ hasText: /^A$/ })).toHaveCount(1)
  await page.waitForTimeout(500)
  expect(await requests()).toEqual([DEFER, 'A'])
})

test('two typed messages queued behind an unresolved send each show once, in order', async () => {
  await say(DEFER)
  await done('Done.\n\n```replies\nA\nB\n```')
  await expect(page.locator('.bubble-msg.assistant').last()).toContainText('Done.')
  await expect(chips()).toHaveCount(0)
  await say('A')
  await say('typed next')
  await expect(userBubbles()).toHaveText(['다음 회의 리마인더 하나 만들어줘.', DEFER, 'A', 'typed next'])
  await resolveFirst()
  await expect.poll(requests).toEqual([DEFER, 'A'])
  await done('Finished A')
  await resolveFirst()
  await expect.poll(requests).toEqual([DEFER, 'A', 'typed next'])
  await expect(userBubbles()).toHaveText(['다음 회의 리마인더 하나 만들어줘.', DEFER, 'A', 'typed next'])
})

test('a draft typed before a background busy blip is kept, no chips come back after it, and it is sent once', async () => {
  const input = page.getByTestId('bots-input')
  await input.fill(DEFER)
  await broadcast({ type: 'comet:working', channel: `bot-${botId}`, working: true })
  await expect(page.getByTestId('bots-typing')).toBeVisible()
  await expect(chips()).toHaveCount(0)
  await broadcast({ type: 'comet:working', channel: `bot-${botId}`, working: false })
  await expect(page.getByTestId('bots-typing')).toBeHidden()
  await expect(chips()).toHaveCount(0)
  await expect(input).toHaveValue(DEFER)
  await input.press('Enter')
  await expect.poll(requests).toEqual([DEFER])
  await expect(userBubbles().filter({ hasText: DEFER })).toHaveCount(1)
})

test('a typed send is unchanged', async () => {
  const input = page.getByTestId('bots-input')
  await input.fill('직접 입력'); await input.press('Enter')
  await expect.poll(requests).toEqual(['직접 입력'])
  await expect(input).toHaveValue('')
})
