// Bot info pane: seeds one bot ('Info Bot') through the running app, then runs checks P1-P6 in order: open the chat,
// the title pill opens a 320px pane on the right beside the thread, the pane has no tab roles, one panel shows the
// avatar, name, instructions and notification level, Escape closes and focus returns to the composer, and the pill
// toggles the pane.
const WAIT_MS = 5_000
const ROW_WAIT_MS = 10_000
const BOT = 'Info Bot'
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
  const paneVisible = async () => await PANE.isVisible() ? '' : 'bot-info-pane not visible'
  const paneClosed = async () => (await PANE.count()) === 0 || !await PANE.isVisible() ? '' : 'bot-info-pane still visible'

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
  await check('no-tabs', async () => {
    const count = await PANE.locator('[role="tablist"], [role="tab"], [role="tabpanel"]').count()
    return count ? `${count} tab-role elements in the pane, expected 0` : ''
  })

  // P4
  await check('one-panel', async () => {
    const panel = PANE.locator('.bot-info-panel')
    if ((await panel.count()) !== 1) return `${await panel.count()} .bot-info-panel elements, expected 1`
    if (!await panel.locator('[data-testid="bot-info-avatar"]').isVisible()) return 'avatar not visible'
    if (!(await panel.locator('h2').innerText({ timeout: WAIT_MS })).includes(BOT)) return `name heading lacks ${BOT}`
    const box = panel.locator('textarea')
    if (!await box.isVisible()) return 'instructions box not visible'
    if (await box.inputValue({ timeout: WAIT_MS }) !== 'Seeded info pane bot') return 'instructions box lacks the seeded purpose'
    return await panel.locator('[role="radiogroup"]').isVisible() ? '' : 'notification level not visible'
  })

  // P5
  await check('esc-closes', async () => {
    await PANE.locator('textarea').focus({ timeout: WAIT_MS })
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
