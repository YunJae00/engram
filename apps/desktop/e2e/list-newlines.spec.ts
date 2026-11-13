import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORD = ['첫 번째', '두 번째', '세 번째', '네 번째', '다섯 번째', '여섯 번째', '일곱 번째', '여덟 번째', '아홉 번째', '열 번째',
  '열한 번째', '열두 번째', '열세 번째', '열네 번째', '열다섯 번째', '열여섯 번째', '열일곱 번째', '열여덟 번째', '열아홉 번째', '스무 번째',
  '스물한 번째', '스물두 번째', '스물세 번째', '스물네 번째', '스물다섯 번째', '스물여섯 번째', '스물일곱 번째', '스물여덟 번째', '스물아홉 번째', '서른 번째']
const ITEMS = ORD.map((word, i) => `${i + 1} – ${word} 줄`).join('\n')

let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

async function open(turns: { role: 'user' | 'assistant'; text: string }[]) {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-list-newlines-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  const botId = (await createBot(paths, { name: 'List newlines fixture' })).id
  const at = new Date().toISOString()
  for (const turn of turns) await appendBotTurn(paths, botId, { ...turn, at })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-list-newlines-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  await page.getByTestId(`bot-${botId}`).click()
  return page
}

test('a line per item answer keeps one line per item', async () => {
  const page = await open([{ role: 'user', text: '1부터 30까지 한 줄씩 세어줘' }, { role: 'assistant', text: ITEMS }])
  const body = page.locator('.bubble-msg.assistant .bubble-msg-body').filter({ hasText: '서른 번째 줄' })
  await expect(body).toHaveCount(1)
  const lines = (await body.innerText()).trim().split('\n')
  expect(lines.length, `LIST-NEWLINES lines=${lines.length} ${JSON.stringify(lines.slice(0, 3))}`).toBe(30)
  const numbered = lines.filter(line => /^\d+ – /.test(line)).length
  expect(numbered, `LIST-NEWLINES numbered=${numbered}`).toBe(30)
  const tops = await body.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const found: number[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/^\d+ – /.test((node.textContent ?? '').trim())) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getClientRects()[0]
      if (rect) found.push(Math.round(rect.top))
    }
    return found
  })
  expect(tops.length, `LIST-NEWLINES items=${tops.length}`).toBe(30)
  expect(new Set(tops).size, `LIST-NEWLINES distinct tops=${new Set(tops).size}`).toBe(30)
  expect(await body.locator('br').count(), 'LIST-NEWLINES br').toBe(29)
})

test('a two line user message keeps two lines', async () => {
  const page = await open([{ role: 'user', text: '첫 줄 한글\n둘째 줄 끝' }, { role: 'assistant', text: '네.' }])
  const user = page.locator('.bubble-msg.user .chat-user-text').filter({ hasText: '둘째 줄 끝' })
  await expect(user).toHaveCount(1)
  expect((await user.innerText()).split('\n')).toEqual(['첫 줄 한글', '둘째 줄 끝'])
  const [first, second] = await user.evaluate(el => {
    const node = el.firstChild as Text
    const top = (index: number) => {
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return Math.round(range.getClientRects()[0]?.top ?? -1)
    }
    return [top(0), top((node.textContent ?? '').indexOf('둘째'))]
  })
  expect(second).toBeGreaterThan(first)
})
