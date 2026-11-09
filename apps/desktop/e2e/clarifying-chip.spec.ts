import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIRST = '내 건도 마감일 정해줘'
const SAME = '박과장이랑 같은 날로'
const NEXT = '이걸 문서로 저장해줘'
const QUESTION = '마감일을 언제로 할까요? 박과장님과 같은 날로 할지, 다른 날로 할지 알려주세요.'
const FAILED = 'Cannot send this choice. Enter a message instead.'
type Fixture = typeof globalThis & { pending: { resolve(): void }[]; requests: string[]; rejectNext: boolean }

let app: ElectronApplication, page: Page, botId: string
test.beforeEach(async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'e2e-clarifying-chip-')), { git: false })
  botId = (await createBot(paths, { name: 'Meeting notes' })).id
  const at = new Date().toISOString()
  await appendBotTurn(paths, botId, { role: 'user', text: '회의록 정리해줘', at })
  await appendBotTurn(paths, botId, { role: 'assistant', text: `정리했어요. 박과장님 건은 금요일 마감이에요.\n\n\`\`\`replies\n${FIRST}\n요약만 보여줘\n\`\`\``, at })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-clarifying-chip-data-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    const fixture = globalThis as Fixture
    fixture.pending = []; fixture.requests = []; fixture.rejectNext = false
    for (const channel of ['chat:send', 'chat:active', 'chat:say']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => [])
    ipcMain.handle('chat:say', () => ({ ok: false }))
    ipcMain.handle('chat:send', (_event, request: { message: string }) => {
      fixture.requests.push(request.message)
      if (fixture.rejectNext) { fixture.rejectNext = false; return Promise.reject(new Error('engine unavailable')) }
      return new Promise<void>(resolve => { fixture.pending.push({ resolve }) })
    })
  })
})
test.afterEach(async () => { await app?.close() })

const requests = () => app.evaluate(() => (globalThis as Fixture).requests)
const resolveAll = () => app.evaluate(() => { const fixture = globalThis as Fixture; for (const one of fixture.pending.splice(0)) one.resolve() })
async function broadcast(event: Record<string, unknown>) {
  await app.evaluate(({ BrowserWindow }, payload) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', payload) }, event)
}
const done = (text: string) => broadcast({ type: 'chat:done', channel: `bot-${botId}`, text })
const offer = (options: string[]) => broadcast({ type: 'chat:offer', channel: `bot-${botId}`, offer: { kind: 'asked', question: QUESTION, options } })
const bubbles = (scope: Locator, text: string) => scope.locator('.bubble-msg.user').filter({ hasText: new RegExp(`^${text}$`) })

async function openFull(): Promise<Locator> {
  await page.getByTestId(`bot-${botId}`).click()
  return page.getByTestId('bots-thread')
}
async function openTile(): Promise<Locator> {
  await expect.poll(() => page.evaluate(() => window.engram.vaultReady()), { timeout: 60_000 }).toBe(true)
  await page.evaluate(id => localStorage.setItem('engram.mission.slots', JSON.stringify([id, null, null, null])), botId)
  await page.reload()
  await page.setViewportSize({ width: 950, height: 900 })
  await page.getByTestId('mission-layout-2').click()
  return page.getByTestId(`mini-chat-${botId}`)
}

async function clarifyThenAnswer(scope: Locator, kind: 'replies' | 'asked', input?: Locator) {
  await expect(scope.getByTestId('reply-chip-0')).toHaveText(FIRST)
  await scope.getByTestId('reply-chip-0').click()
  await expect.poll(requests).toEqual([FIRST])
  await done(kind === 'replies' ? `${QUESTION}\n\n\`\`\`replies\n${SAME}\n다른 날로\n\`\`\`` : QUESTION)
  if (kind === 'asked') await offer([SAME, '다른 날로'])
  await resolveAll()
  const chip = scope.getByTestId(kind === 'replies' ? 'reply-chip-0' : 'bots-choice-0')
  await expect(chip).toContainText(SAME)
  if (input) await input.fill('composer draft')
  await chip.click()
  await expect(bubbles(scope, SAME)).toHaveCount(1)
  await expect.poll(requests).toEqual([FIRST, SAME])
  if (kind === 'asked') await expect(scope.getByTestId('bots-choices')).toHaveCount(0)
  if (input) await expect(input).toHaveValue('composer draft')
  if (await chip.count()) await chip.dispatchEvent('click')
  await page.waitForTimeout(400)
  expect(await requests()).toEqual([FIRST, SAME])
  await expect(bubbles(scope, SAME)).toHaveCount(1)
  await done(`금요일로 맞췄어요.\n\n\`\`\`replies\n${NEXT}\n\`\`\``)
  await resolveAll()
  await expect(scope.getByTestId('reply-chip-0')).toHaveText(NEXT)
  await scope.getByTestId('reply-chip-0').click()
  await expect.poll(requests).toEqual([FIRST, SAME, NEXT])
  await expect(bubbles(scope, NEXT)).toHaveCount(1)
}

test('full view: a reply chip on a clarifying answer after a chip sends once', async () => {
  await clarifyThenAnswer(await openFull(), 'replies', page.getByTestId('bots-input'))
})

test('full view: an asked choice after a chip sends once and leaves the composer alone', async () => {
  await clarifyThenAnswer(await openFull(), 'asked', page.getByTestId('bots-input'))
})

test('tile: a reply chip on a clarifying answer after a chip sends once', async () => {
  await clarifyThenAnswer(await openTile(), 'replies', page.getByTestId(`mini-input-${botId}`))
})

test('tile: an asked choice after a chip sends once', async () => {
  await clarifyThenAnswer(await openTile(), 'asked')
})

test('a choice behind an unresolved send, a repeated label, invalid options and a failed send are never silent', async () => {
  const scope = await openFull()
  await scope.getByTestId('reply-chip-0').click()
  await expect.poll(requests).toEqual([FIRST])
  await done(QUESTION)
  await offer([SAME, '다른 날로'])
  await scope.getByTestId('bots-choice-0').click()
  await expect(bubbles(scope, SAME)).toHaveCount(1)
  await page.waitForTimeout(300)
  expect(await requests()).toEqual([FIRST])
  await resolveAll()
  await expect.poll(requests).toEqual([FIRST, SAME])
  await done('금요일로 할게요.')
  await resolveAll()

  await offer([SAME])
  await scope.getByTestId('bots-choice-0').click()
  await expect(bubbles(scope, SAME)).toHaveCount(2)
  await expect.poll(requests).toEqual([FIRST, SAME, SAME])
  await done('다시 금요일로 맞췄어요.')
  await resolveAll()

  const users = await scope.locator('.bubble-msg.user').count()
  for (const invalid of ['   ', `${'가 '.repeat(1000)}다`]) {
    await offer([invalid])
    for (const attempt of [1, 2]) {
      await scope.getByTestId('bots-choice-0').click()
      await expect(page.locator('.toast'), `attempt ${attempt}`).toHaveText(FAILED)
      await expect(scope.getByTestId('bots-choice-0')).toBeVisible()
    }
  }
  await page.waitForTimeout(300)
  await expect(scope.locator('.bubble-msg.user')).toHaveCount(users)
  expect(await requests()).toEqual([FIRST, SAME, SAME])

  await app.evaluate(() => { (globalThis as Fixture).rejectNext = true })
  await offer(['실패해도 보여줘'])
  await scope.getByTestId('bots-choice-0').click()
  await expect.poll(requests).toEqual([FIRST, SAME, SAME, '실패해도 보여줘'])
  await expect(scope.locator('.bubble-msg.assistant.error')).toHaveCount(1)
  await expect(bubbles(scope, '실패해도 보여줘')).toHaveCount(1)
})
