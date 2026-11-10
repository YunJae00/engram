// Bot fresh start: forces the English UI, creates one bot ('Fresh Bot') through the running app, writes four
// transcript turns and one memory fact as files, reloads, then runs checks F1-F7 in order: the chat shows the seeded
// turns; Start over asks for confirmation before anything is archived; confirming empties the live chat; exactly one
// byte-identical archive is on disk and listed by botConversations; the info pane's Past chats tab lists it and opens it
// read-only with the same bubble style; the memory fact is kept on disk, in botMemory and in the Overview tab. Until
// rd-fresh-start-ui and rd-info-past-tab land, Start over, its confirmation and the Past chats list do not exist and
// this scenario returns ok:false with evidence naming the failed checks; that is the expected result on current code.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const WAIT_MS = 5_000
const ROW_WAIT_MS = 10_000
const BOT = 'Fresh Bot'
const TURNS = [
  { role: 'user', text: 'zq fresh question one', at: '2026-11-01T09:00:00.000Z' },
  { role: 'assistant', text: 'zq fresh answer one', at: '2026-11-01T09:00:05.000Z' },
  { role: 'user', text: 'zq fresh question two', at: '2026-11-01T09:01:00.000Z' },
  { role: 'assistant', text: 'zq fresh answer two', at: '2026-11-01T09:01:05.000Z' },
]
const FACT = { id: 'f-fresh-0001', text: 'Prefers weekly summaries on Friday', at: '2026-11-01T09:02:00.000Z', touchedAt: '2026-11-01T09:02:00.000Z' }
const CHAT = TURNS.map((turn) => `${JSON.stringify(turn)}\n`).join('')
const MEMORY = JSON.stringify({ facts: [FACT], turns: 2 }, null, 2)
const STYLE_KEYS = ['backgroundColor', 'color', 'fontSize', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'paddingTop', 'paddingLeft']
const VIEW_SEL = '[data-testid="bots-view"]'
const THREAD_SEL = '[data-testid="bots-thread"]'
const PANE_SEL = '[data-testid="bot-info-pane"]'
const PAST_VIEW_SEL = '[data-testid="bot-past-view"]'

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

// Computed style of the first user and first assistant .bubble-msg inside the first element matching sel.
function readStyles(page, sel) {
  return page.evaluate(({ sel, keys }) => {
    const root = globalThis.document.querySelector(sel)
    if (!root) return { error: `no ${sel}` }
    const out = {}
    for (const role of ['user', 'assistant']) {
      const bubble = root.querySelector(`.bubble-msg.${role}`)
      if (!bubble) return { error: `no .bubble-msg.${role} in ${sel}` }
      const style = globalThis.getComputedStyle(bubble)
      out[role] = Object.fromEntries(keys.map((key) => [key, style[key]]))
    }
    return { styles: out }
  }, { sel, keys: STYLE_KEYS })
}

export async function run(page, { paths }) {
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
  const id = await page.evaluate(async (name) => {
    await globalThis.engram.settingsSet({ uiLanguage: 'en' })
    return (await globalThis.engram.botCreate({ name, purpose: 'Seeded fresh start bot' })).id
  }, BOT)
  const chats = join(paths.cache, 'bot-chats')
  const memoryFile = join(paths.cache, 'bot-memory', `${id}.json`)
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, `${id}.jsonl`), CHAT)
  await mkdir(join(paths.cache, 'bot-memory'), { recursive: true })
  await writeFile(memoryFile, MEMORY)
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const checks = {}
  const failures = []
  const evidence = { seeded: { id }, archive: null, checks, failures }
  const ROW = page.locator(`[data-testid="bot-${id}"]`).first()
  const PILL = page.locator(`${VIEW_SEL} [data-testid="bots-title-pill"]`)
  const THREAD = page.locator(THREAD_SEL)
  const FRESH = page.locator(`${VIEW_SEL} [data-testid="bots-fresh"]`)
  const CONFIRM = page.locator('[role="dialog"][data-testid="bots-fresh-confirm"]')
  const OK = CONFIRM.locator('[data-testid="bots-fresh-confirm-ok"]')
  const PANE = page.locator(PANE_SEL)
  const VIEW = page.locator(PAST_VIEW_SEL)
  const api = (method) => page.evaluate(({ method, id }) => globalThis.engram[method](id), { method, id })
  const textsIn = async (loc, what) => {
    const text = await loc.innerText({ timeout: WAIT_MS })
    const missing = TURNS.find((turn) => !text.includes(turn.text))
    return missing ? `${what} lacks '${missing.text}'` : ''
  }
  const visiblePanel = async () => {
    const panels = PANE.locator('[role="tabpanel"]')
    const shown = []
    for (let i = 0; i < await panels.count(); i++) if (await panels.nth(i).isVisible()) shown.push(panels.nth(i))
    return shown.length === 1 ? { panel: shown[0] } : { reason: `${shown.length} visible tabpanels, expected 1` }
  }
  const openTab = async (name) => {
    if (!await PANE.isVisible()) await PILL.click({ timeout: WAIT_MS })
    const shown = await until(async () => await PANE.isVisible() ? '' : 'bot-info-pane not visible')
    if (shown) return shown
    const tabs = PANE.locator('[role="tab"]')
    for (let i = 0; i < await tabs.count(); i++) {
      const tab = tabs.nth(i)
      const label = await tab.evaluate((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(), null, { timeout: WAIT_MS })
      if (label === name) { await tab.click({ timeout: WAIT_MS }); return '' }
    }
    return `no ${name} tab`
  }

  let opened = false
  let style = null
  let archive = null
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
    const shown = await until(async () => {
      if (!(await PILL.innerText({ timeout: WAIT_MS })).includes(BOT)) return `title pill text lacks ${BOT}`
      return textsIn(THREAD, 'bots-thread')
    })
    if (shown) return shown
    const read = await readStyles(page, THREAD_SEL)
    if (read.error) return read.error
    style = read.styles
  })

  // F2
  await check('confirm-first', async () => {
    await FRESH.click({ timeout: WAIT_MS })
    const shown = await until(async () => await CONFIRM.isVisible() ? '' : 'bots-fresh-confirm not visible')
    if (shown) return shown
    const listed = await api('botConversations')
    if (!Array.isArray(listed) || listed.length !== 0) return `botConversations has ${listed?.length} entries before confirming`
    return textsIn(THREAD, 'bots-thread while confirming')
  })

  // F3
  await check('chat-empty', async () => {
    await OK.click({ timeout: WAIT_MS })
    const closed = await until(async () => (await CONFIRM.count()) === 0 || !await CONFIRM.isVisible() ? '' : 'bots-fresh-confirm still visible')
    if (closed) return closed
    return until(async () => {
      if (!isDeepStrictEqual(await api('botTranscript'), [])) return 'botTranscript is not []'
      const text = await page.locator(VIEW_SEL).innerText({ timeout: WAIT_MS })
      const left = TURNS.find((turn) => text.includes(turn.text))
      return left ? `bots-view still shows '${left.text}'` : ''
    })
  })

  // F4
  await check('archived-once', async () => {
    const pattern = new RegExp(`^${id}\\.(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.jsonl$`)
    let name = null
    const found = await until(async () => {
      const names = await readdir(chats)
      const hits = names.filter((n) => pattern.test(n))
      if (hits.length !== 1) return `${hits.length} archives of ${id} in bot-chats, expected 1`
      if (names.includes(`${id}.jsonl`)) return `${id}.jsonl still in bot-chats`
      name = hits[0]
      return ''
    })
    if (found) return found
    archive = pattern.exec(name)[1]
    evidence.archive = archive
    if (await readFile(join(chats, name), 'utf8') !== CHAT) return `${name} differs from the seeded transcript`
    const listed = await api('botConversations')
    return isDeepStrictEqual(listed, [{ stamp: archive, turns: 4 }]) ? '' : `botConversations is ${JSON.stringify(listed).slice(0, 120)}`
  })

  // F5
  await check('past-read-only', async () => {
    const tab = await openTab('Past chats')
    if (tab) return tab
    let panel
    const listed = await until(async () => {
      const found = await visiblePanel()
      if (found.reason) return found.reason
      panel = found.panel
      const count = await panel.locator('[data-testid="bot-past-item"]').count()
      return count === 1 ? '' : `${count} bot-past-item in the Past chats panel, expected 1`
    })
    if (listed) return listed
    await panel.locator('[data-testid="bot-past-item"]').click({ timeout: WAIT_MS })
    const shown = await until(async () => await VIEW.isVisible() ? '' : 'bot-past-view not visible')
    if (shown) return shown
    const inPane = await VIEW.evaluate((el, sel) => el.closest(sel) !== null, PANE_SEL, { timeout: WAIT_MS })
    if (!inPane) return 'bot-past-view is not inside bot-info-pane'
    const bubbles = VIEW.locator('.bubble-msg')
    if ((await bubbles.count()) !== 4) return `${await bubbles.count()} .bubble-msg in bot-past-view, expected 4`
    for (let i = 0; i < 4; i++) {
      if (!(await bubbles.nth(i).innerText({ timeout: WAIT_MS })).includes(TURNS[i].text)) return `bubble ${i + 1} lacks '${TURNS[i].text}'`
    }
    const editable = await VIEW.locator('textarea, input, [contenteditable="true"], [data-testid="bots-input"]').count()
    if (editable) return `bot-past-view holds ${editable} editable element(s)`
    return (await PANE.locator('[data-testid="bots-input"]').count()) ? 'bot-info-pane holds bots-input' : ''
  })

  // F6
  await check('same-bubbles', async () => {
    if (!style) return 'no live style'
    if (!await VIEW.count()) return 'no past view'
    const read = await readStyles(page, `${PANE_SEL} ${PAST_VIEW_SEL}`)
    if (read.error) return read.error
    for (const role of ['user', 'assistant']) {
      for (const key of STYLE_KEYS) {
        if (read.styles[role][key] !== style[role][key]) return `${role} ${key} ${read.styles[role][key]}, live ${style[role][key]}`
      }
    }
  })

  // F7
  await check('memory-kept', async () => {
    if (await readFile(memoryFile, 'utf8') !== MEMORY) return 'bot-memory file changed'
    const facts = await api('botMemory')
    if (!facts.some((fact) => fact.id === FACT.id && fact.text === FACT.text)) return `botMemory lacks ${FACT.id}`
    const tab = await openTab('Overview')
    if (tab) return tab
    return until(async () => {
      const found = await visiblePanel()
      if (found.reason) return found.reason
      const fact = found.panel.locator('[data-testid="bot-fact-f-fresh-0001"]')
      if (!await fact.isVisible()) return 'bot-fact-f-fresh-0001 not visible in the Overview panel'
      return (await fact.innerText({ timeout: WAIT_MS })).includes(FACT.text) ? '' : 'fact text missing in Overview'
    })
  })

  return { ok: failures.length === 0, evidence }
}
