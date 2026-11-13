import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, readBotTranscript, resetBotsToV2, type VaultPaths } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const baseEnv = (root: string, data: string, extra: Record<string, string>) => ({ ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_HIDDEN: '1', ...extra })

let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

async function vault(): Promise<{ root: string; data: string; paths: VaultPaths; botId: string }> {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-relaunch-order-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'Relaunch order fixture' })).id
  return { root, data: await mkdtemp(join(TMP, 'e2e-relaunch-order-data-')), paths, botId }
}

async function openBot(page: Page, botId: string): Promise<Page> {
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  await page.getByTestId(`bot-${botId}`).click()
  return page
}

async function launch(root: string, data: string, botId: string, extra: Record<string, string>): Promise<Page> {
  app = await electron.launch({ args: [MAIN, '--no-sandbox'], env: baseEnv(root, data, extra) })
  return openBot(await app.firstWindow(), botId)
}

async function relaunch(root: string, data: string, botId: string, extra: Record<string, string>): Promise<Page> {
  await app?.close()
  app = await electron.launch({ args: [MAIN, '--no-sandbox'], env: baseEnv(root, data, extra) })
  return openBot(await app.firstWindow(), botId)
}

const bubbles = (page: Page) => page.locator('.bots-view .bubble-msg').evaluateAll(nodes => nodes.map(node => ({ user: node.classList.contains('user'), text: (node.textContent ?? '').trim() })))

test('reopened transcript keeps the live order around a mid-stream message', async () => {
  const { root, data, paths, botId } = await vault()
  const at = new Date().toISOString()
  const turns = [
    { role: 'user' as const, text: 'Count to thirty' },
    { role: 'assistant' as const, text: 'Counted to thirty.\n\n```replies\nMore up to 50', progress: true },
    { role: 'user' as const, text: 'Then only the even ones' },
    { role: 'assistant' as const, text: 'Counted to thirty.\n\n```replies\nMore up to 50\nThanks\n```' },
    { role: 'user' as const, text: 'Kings please' },
    { role: 'assistant' as const, text: 'Here are the kings.' },
  ]
  for (const turn of turns) await appendBotTurn(paths, botId, { ...turn, at })
  const anchors = ['Count to thirty', 'Counted to thirty.', 'Then only the even ones', 'Kings please', 'Here are the kings.']
  const check = async (page: Page, when: string) => {
    await expect(page.locator('.bots-view .bubble-msg').filter({ hasText: 'Here are the kings.' })).toBeVisible()
    const list = await bubbles(page)
    const texts = list.map(one => one.text)
    const indices = anchors.map(anchor => texts.findIndex(text => text.includes(anchor)))
    expect(indices.every(index => index >= 0), `RELAUNCH-ORDER ${when} missing ${JSON.stringify(texts)}`).toBe(true)
    expect(indices, `RELAUNCH-ORDER ${when} order ${JSON.stringify(texts)}`).toEqual([...indices].sort((a, b) => a - b))
    expect(texts.filter(text => text.includes('Counted to thirty.')).length, `RELAUNCH-ORDER ${when} once ${JSON.stringify(texts)}`).toBe(1)
    for (const one of list.filter(item => !item.user)) {
      expect(['```', 'More up to 50', 'Thanks'].filter(bad => one.text.includes(bad)), `RELAUNCH-ORDER ${when} leak ${JSON.stringify(one.text)}`).toEqual([])
    }
  }
  await check(await launch(root, data, botId, { ENGRAM_ENGINE: 'none' }), 'first')
  await check(await relaunch(root, data, botId, { ENGRAM_ENGINE: 'none' }), 'reopened')
})

test('a stopped turn keeps its reply after relaunch', async () => {
  const { root, data, paths, botId } = await vault()
  const env = { ENGRAM_ENGINE: 'mock', ENGRAM_TEST_HANG_CHAT: '1' }
  const page = await launch(root, data, botId, env)
  const input = page.getByTestId('bots-input')
  await input.fill('Count slowly')
  await input.press('Enter')
  await expect(page.locator('.bubble-stop')).toBeVisible()
  await expect.poll(async () => (await readBotTranscript(paths, botId)).at(-1)?.role, { message: 'STOP-KEPT user turn on disk' }).toBe('user')
  await page.locator('.bubble-stop').click()
  await expect(page.locator('.bots-view .bubble-msg.assistant').filter({ hasText: 'Stopped.' })).toBeVisible()
  await expect.poll(async () => (await readBotTranscript(paths, botId)).map(turn => `${turn.role}:${turn.text}`), { message: 'STOP-KEPT on disk' }).toEqual(['user:Count slowly', 'assistant:Stopped.'])
  const again = await relaunch(root, data, botId, env)
  await expect(again.locator('.bots-view .bubble-msg').filter({ hasText: 'Count slowly' })).toBeVisible()
  const after = await bubbles(again)
  const asked = after.findIndex(one => one.user && one.text.includes('Count slowly'))
  expect(after[asked + 1], `STOP-KEPT reopened ${JSON.stringify(after)}`).toMatchObject({ user: false, text: expect.stringContaining('Stopped.') })
  const next = again.getByTestId('bots-input')
  await next.fill('And then?')
  await next.press('Enter')
  await expect(again.locator('.bots-view .bubble-msg.user').filter({ hasText: 'And then?' })).toBeVisible()
  const later = await bubbles(again)
  const sent = later.findIndex(one => one.user && one.text.includes('And then?'))
  expect(later[sent - 1]?.user, `STOP-KEPT stacked ${JSON.stringify(later)}`).toBe(false)
  expect(later.slice(asked, sent + 1).map(one => one.text.includes('Count slowly') ? 'Count slowly' : one.text.includes('Stopped.') ? 'Stopped.' : one.text), `STOP-KEPT order ${JSON.stringify(later)}`).toEqual(['Count slowly', 'Stopped.', 'And then?'])
})
