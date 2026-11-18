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
  const VIEW = page.locator('[data-testid="bots-view"]')
  const PILL = page.locator('[data-testid="bots-title-pill"]')
  const INPUT = page.locator('[data-testid="bots-input"]')
  const PANE = page.locator(PANE_SEL)
  const EMPTY = page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"]')

  let opened = false
  const check = async (checkId, body) => {
    const reason = checkId === 'open-chat' || opened ? await body().catch(short) : 'chat did not open'
    if (reason) { checks[checkId] = reason; failures.push(checkId) } else checks[checkId] = 'pass'
    return !reason
  }

  opened = await check('open-chat', async () => {
    const row = await until(async () => await ROW.isVisible() ? '' : `${BOT} row not visible`, ROW_WAIT_MS)
    if (row) return row
    await ROW.click({ timeout: WAIT_MS })
    return until(async () => await INPUT.isVisible() ? '' : 'bots-input not visible')
  })

  await check('no-pill-no-pane', async () => {
    if (await PILL.count()) return `${await PILL.count()} bots-title-pill elements, expected 0`
    if (await PANE.count()) return `${await PANE.count()} bot-info-pane elements, expected 0`
    if (await page.locator('.bot-info-panel, [data-testid="bot-info-avatar"], [data-testid="bots-memory"], [data-testid="bot-routines"]').count()) return 'pane contents are still rendered'
    await INPUT.focus({ timeout: WAIT_MS })
    await page.keyboard.press('Escape')
    return await INPUT.isVisible() ? '' : 'bots-input not visible after Escape'
  })

  await check('no-tabs', async () => {
    const count = await VIEW.locator('[role="tablist"], [role="tab"], [role="tabpanel"]').count()
    return count ? `${count} tab-role elements in the chat, expected 0` : ''
  })

  await check('empty-thread', async () => until(async () => {
    if (!await EMPTY.isVisible()) return 'bot-empty not visible'
    if (!(await EMPTY.locator('h2').innerText({ timeout: WAIT_MS })).includes(BOT)) return `empty thread name lacks ${BOT}`
    if (!await EMPTY.locator('.bot-avatar').first().isVisible()) return 'empty thread avatar not visible'
    return await EMPTY.locator('button').count() ? 'the empty thread holds buttons (example chips), expected none' : ''
  }))

  await check('sidebar-row', async () => {
    if (!(await ROW.innerText({ timeout: WAIT_MS })).includes(BOT)) return `row text lacks ${BOT}`
    return await ROW.locator('.bot-avatar').first().isVisible() ? '' : 'row avatar not visible'
  })

  await check('edited-through-app', async () => {
    await page.evaluate((bot) => globalThis.engram.botUpdate(bot, { purpose: 'Changed in chat', notify: 'off' }), id)
    return until(async () => {
      const bot = (await page.evaluate(() => globalThis.engram.botsList())).find((one) => one.id === id)
      if (bot?.purpose !== 'Changed in chat') return `botsList purpose is ${JSON.stringify(bot?.purpose)}`
      if (bot?.notify !== 'off') return `botsList notify is ${JSON.stringify(bot?.notify)}`
      return await ROW.locator('.sidebar-bell-off').isVisible() ? '' : 'the row does not show notifications off'
    })
  })

  return { ok: failures.length === 0, evidence }
}
