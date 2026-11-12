// Bot fresh start: forces the English UI, creates one bot ('Fresh Bot') through the running app, writes two transcript
// turns as a file, reloads, then runs checks F1-F2: the chat shows the seeded turns, and in light and dark the chat has
// no start-over button (no bots-fresh, no 'New chat' button) and no bots-fresh-confirm dialog, while the title pill and
// composer are still visible.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const WAIT_MS = 5_000
const ROW_WAIT_MS = 10_000
const BOT = 'Fresh Bot'
const TURNS = [
  { role: 'user', text: 'zq fresh question one', at: '2026-11-01T09:00:00.000Z' },
  { role: 'assistant', text: 'zq fresh answer one', at: '2026-11-01T09:00:05.000Z' },
]
const CHAT_SEL = '[data-testid="bots-view"] .bots-chat'

const short = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

async function until(probe, ms = WAIT_MS) {
  const end = Date.now() + ms
  let reason
  do {
    reason = await probe().catch(short)
    if (!reason) return ''
    await pause(100)
  } while (Date.now() < end)
  return reason
}

export async function run(page, { paths }) {
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
  const id = await page.evaluate(async (name) => {
    await globalThis.engram.settingsSet({ uiLanguage: 'en' })
    return (await globalThis.engram.botCreate({ name, purpose: 'Seeded fresh start bot' })).id
  }, BOT)
  const chats = join(paths.cache, 'bot-chats')
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, `${id}.jsonl`), TURNS.map((turn) => `${JSON.stringify(turn)}\n`).join(''))
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const checks = {}
  const failures = []
  const ROW = page.locator(`[data-testid="bot-${id}"]`).first()
  const CHAT = page.locator(CHAT_SEL)
  const PILL = CHAT.locator('[data-testid="bots-title-pill"]')
  const INPUT = CHAT.locator('[data-testid="bots-input"]')
  let opened = false
  const check = async (checkId, body) => {
    const reason = checkId === 'open-chat' || opened ? await body().catch(short) : 'chat did not open'
    if (reason) { checks[checkId] = reason; failures.push(checkId) } else checks[checkId] = 'pass'
    return !reason
  }

  // F1
  opened = await check('open-chat', async () => {
    const row = await until(async () => await ROW.isVisible() ? '' : `${BOT} row not visible`, ROW_WAIT_MS)
    if (row) return row
    await ROW.click({ timeout: WAIT_MS })
    return until(async () => {
      if (!(await PILL.innerText({ timeout: WAIT_MS })).includes(BOT)) return `title pill text lacks ${BOT}`
      const text = await page.locator('[data-testid="bots-thread"]').innerText({ timeout: WAIT_MS })
      const missing = TURNS.find((turn) => !text.includes(turn.text))
      return missing ? `bots-thread lacks '${missing.text}'` : ''
    })
  })

  // F2
  await check('no-start-over', async () => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (value) => {
        const settings = await globalThis.engram.settingsGet()
        await globalThis.engram.settingsSet({ ...settings, theme: value })
      }, theme)
      const themed = await until(async () => await page.locator('html').getAttribute('data-theme') === theme ? '' : `html data-theme is not ${theme}`)
      if (themed) return themed
      if (!await PILL.isVisible()) return `${theme}: title pill not visible`
      if (!await INPUT.isVisible()) return `${theme}: composer not visible`
      const found = {
        fresh: await page.locator('[data-testid="bots-fresh"]').count(),
        named: await CHAT.getByRole('button', { name: 'New chat', exact: true }).count(),
        confirm: await page.locator('[data-testid="bots-fresh-confirm"]').count(),
      }
      if (found.fresh + found.named + found.confirm) return `${theme}: start over still present ${JSON.stringify(found)}`
    }
    return ''
  })

  return { ok: failures.length === 0, evidence: { seeded: { id }, checks, failures } }
}
