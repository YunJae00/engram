// Bot info pane: seeds one bot ('Info Bot') through the running app, then runs checks P1-P6 in order: open the chat,
// the title pill opens a 320px pane on the right beside the thread, one tablist holding the five tabs, each tab shows
// its linked panel (empty tabs: one 13px line plus one button), Escape closes and focus returns to the composer, and
// the pill toggles the pane. Until rd-info-pane-shell lands, the pane does not exist and this scenario returns
// ok:false with evidence naming P2-P6 as failed; that is the expected result on current code.
const WAIT_MS = 5_000
const ROW_WAIT_MS = 10_000
const BOT = 'Info Bot'
const TABS = ['Overview', 'Routines', 'Files', 'Computer', 'Past chats']
const PANE_SEL = '[data-testid="bot-info-pane"]'

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

// Pane tabs in DOM order with the pinned name rule (aria-label if present, else textContent, trimmed).
function readTabs(page) {
  return page.evaluate((sel) => {
    const panes = globalThis.document.querySelectorAll(sel)
    if (panes.length !== 1) return { error: `${panes.length} bot-info-pane elements` }
    const pane = panes[0]
    const lists = [...pane.querySelectorAll('[role="tablist"]')]
    const tabs = [...pane.querySelectorAll('[role="tab"]')].map((tab) => ({
      name: (tab.getAttribute('aria-label') ?? tab.textContent ?? '').trim(),
      selected: tab.getAttribute('aria-selected'),
      controls: tab.getAttribute('aria-controls') ?? '',
      inList: lists.length === 1 && lists[0].contains(tab),
    }))
    return { lists: lists.length, inSole: lists.length === 1 ? lists[0].querySelectorAll('[role="tab"]').length : 0, tabs }
  }, PANE_SEL)
}

export async function run(page) {
  const id = await page.evaluate(async (name) => {
    await globalThis.engram.settingsSet({ uiLanguage: 'en' })
    return (await globalThis.engram.botCreate({ name, purpose: 'Seeded info pane bot' })).id
  }, BOT)
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const checks = {}
  const failures = []
  const evidence = { seeded: { id }, checks, failures }
  const ROW = page.locator(`[data-testid="bot-${id}"]`).first()
  const PILL = page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]')
  const INPUT = page.locator('[data-testid="bots-input"]')
  const PANE = page.locator(PANE_SEL)
  const TAB = (index) => PANE.locator('[role="tab"]').nth(index)
  const paneVisible = async () => await PANE.isVisible() ? '' : 'bot-info-pane not visible'
  const paneClosed = async () => (await PANE.count()) === 0 || !await PANE.isVisible() ? '' : 'bot-info-pane still visible'
  const tabIndex = async (name) => {
    const read = await readTabs(page)
    if (read.error) return { reason: read.error }
    const index = read.tabs.findIndex((tab) => tab.name === name)
    return index < 0 ? { reason: `no ${name} tab` } : { index, read }
  }

  let opened = false
  const check = async (checkId, body) => {
    const reason = checkId === 'open-chat' || opened ? await body().catch(short) : 'chat did not open'
    if (reason) { checks[checkId] = reason; failures.push(checkId) } else checks[checkId] = 'pass'
    return !reason
  }

  // P1
  opened = await check('open-chat', async () => {
    const row = await until(async () => await ROW.isVisible() ? '' : `${BOT} row not visible`, ROW_WAIT_MS)
    if (row) return row
    await ROW.click({ timeout: WAIT_MS })
    return until(async () => {
      if (!await PILL.isVisible()) return 'title pill not visible'
      if (!(await PILL.innerText({ timeout: WAIT_MS })).includes(BOT)) return `title pill text lacks ${BOT}`
      return await INPUT.isVisible() ? '' : 'bots-input not visible'
    })
  })

  // P2
  await check('pill-opens', async () => {
    await PILL.click({ timeout: WAIT_MS })
    const shown = await until(paneVisible)
    if (shown) return shown
    return until(async () => {
      const boxes = await page.evaluate((sel) => {
        const doc = globalThis.document
        const panes = doc.querySelectorAll(sel)
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
        return { panes: panes.length, pane: rect(panes[0]), view: rect(doc.querySelector('[data-testid="bots-view"]')), thread: rect(doc.querySelector('[data-testid="bots-thread"]')) }
      }, PANE_SEL)
      const { pane: a, view, thread: b } = boxes
      if (boxes.panes !== 1) return `${boxes.panes} bot-info-pane elements`
      if (!a || !view || !b) return 'missing box for pane, bots-view or bots-thread'
      if (Math.abs(a.w - 320) > 2) return `pane width ${a.w}, expected 320±2`
      if (Math.abs((a.x + a.w) - (view.x + view.w)) > 2) return `pane right ${a.x + a.w} is not at bots-view right ${view.x + view.w}`
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return 'pane overlaps bots-thread'
      return ''
    })
  })

  // P3
  await check('tablist', async () => {
    const read = await readTabs(page)
    if (read.error) return read.error
    if (read.lists !== 1) return `${read.lists} tablists in the pane, expected 1`
    if (read.tabs.length !== 5) return `${read.tabs.length} tabs in the pane, expected 5`
    if (read.inSole !== 5 || !read.tabs.every((tab) => tab.inList)) return 'the tablist does not hold the five tabs'
    const names = read.tabs.map((tab) => tab.name)
    if (JSON.stringify(names) !== JSON.stringify(TABS)) return `tab names ${JSON.stringify(names)}, expected ${JSON.stringify(TABS)}`
  })

  const emptyReason = async (empty) => {
    if (!await empty.isVisible()) return 'bot-info-empty not visible'
    const line = empty.locator('p')
    const button = empty.locator('button')
    if ((await line.count()) !== 1) return `${await line.count()} <p> in bot-info-empty, expected 1`
    if ((await button.count()) !== 1) return `${await button.count()} <button> in bot-info-empty, expected 1`
    if (!await line.isVisible()) return 'empty line not visible'
    if (!(await line.innerText({ timeout: WAIT_MS })).trim()) return 'empty line has no text'
    const size = await line.evaluate((el) => globalThis.getComputedStyle(el).fontSize, null, { timeout: WAIT_MS })
    if (size !== '13px') return `empty line font-size ${size}, expected '13px'`
    if (!await button.isVisible()) return 'empty action button not visible'
    const label = await button.evaluate((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(), null, { timeout: WAIT_MS })
    return label ? '' : 'empty action button has no accessible text'
  }

  // P4
  await check('tab-panels', async () => {
    for (const name of TABS) {
      const found = await tabIndex(name)
      if (found.reason) return found.reason
      await TAB(found.index).click({ timeout: WAIT_MS })
      const reason = await until(async () => {
        const read = await readTabs(page)
        if (read.error) return read.error
        const tab = read.tabs.find((t) => t.name === name)
        if (!tab) return `no ${name} tab`
        if (tab.selected !== 'true') return `${name} aria-selected is ${tab.selected}`
        const others = read.tabs.filter((t) => t !== tab)
        if (others.length !== 4 || others.some((t) => t.selected !== 'false')) return `the other tabs are not all aria-selected false after clicking ${name}`
        if (!tab.controls) return `${name} has empty aria-controls`
        const panels = PANE.locator('[role="tabpanel"]')
        const shown = []
        for (let i = 0; i < await panels.count(); i++) if (await panels.nth(i).isVisible()) shown.push(panels.nth(i))
        if (shown.length !== 1) return `${shown.length} visible tabpanels after clicking ${name}, expected 1`
        const panel = shown[0]
        if (await panel.getAttribute('id', { timeout: WAIT_MS }) !== tab.controls) return `visible tabpanel id is not ${name} aria-controls`
        if (name === 'Overview') return (await panel.innerText({ timeout: WAIT_MS })).includes(BOT) ? '' : `Overview panel lacks ${BOT}`
        const empties = panel.locator('[data-testid="bot-info-empty"]')
        let last = 'no bot-info-empty in the panel'
        for (let i = 0; i < await empties.count(); i++) {
          last = await emptyReason(empties.nth(i))
          if (!last) return ''
        }
        return `${name}: ${last}`
      })
      if (reason) return reason
    }
  })

  // P5
  await check('esc-closes', async () => {
    const found = await tabIndex('Overview')
    if (found.reason) return found.reason
    await TAB(found.index).focus({ timeout: WAIT_MS })
    await page.keyboard.press('Escape')
    const closed = await until(paneClosed)
    if (closed) return `after Escape: ${closed}`
    return until(async () => await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-testid')) === 'bots-input' ? '' : 'focus is not on bots-input after Escape')
  })

  // P6
  await check('pill-toggles', async () => {
    await PILL.click({ timeout: WAIT_MS })
    const shown = await until(paneVisible)
    if (shown) return `after first click: ${shown}`
    await PILL.click({ timeout: WAIT_MS })
    const closed = await until(paneClosed)
    return closed ? `after second click: ${closed}` : ''
  })

  return { ok: failures.length === 0, evidence }
}
