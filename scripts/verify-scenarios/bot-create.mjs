const WAIT_MS = 5_000
const PLUS_SEL = '.app-sidebar [data-testid="sidebar-create"]'
const DIALOG_SEL = '[role="dialog"][data-testid="create-bot-dialog"]'
const PREVIEW_SEL = '[data-testid="create-bot-preview"] .bot-avatar'
const PICKER_SEL = '[data-testid="avatar-picker"]'
const INPUT_SEL = '[data-testid="bots-input"]'
const EMPTY_SEL = '[data-testid="bots-thread"] [data-testid="bot-empty"]'
const ROW_SEL = (id) => `.app-sidebar [data-testid="bot-${id}"]`

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
  await page.evaluate(() => globalThis.engram.settingsSet({ uiLanguage: 'en' }))
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const checks = {}
  const failures = []
  const PLUS = page.locator(PLUS_SEL)
  const DIALOG = page.locator(DIALOG_SEL)
  const NAME = DIALOG.locator('[data-testid="create-bot-name"]')
  const SUBMIT = DIALOG.locator('[data-testid="create-bot-submit"]')
  const CHANGE = DIALOG.locator('[data-testid="create-bot-avatar-change"]')
  const PREVIEW = DIALOG.locator(PREVIEW_SEL)
  const PICKER = page.locator(PICKER_SEL)
  const INPUT = page.locator(INPUT_SEL)

  const listBots = () => page.evaluate(() => globalThis.engram.botsList())
  const visible = (loc, what) => async () => await loc.isVisible() ? '' : `${what} not visible`
  const closed = async () => (await DIALOG.count()) === 0 || !await DIALOG.isVisible() ? '' : 'create-bot-dialog still visible'
  const ensureClosed = async () => {
    if (!await closed()) return ''
    await page.keyboard.press('Escape')
    return await until(closed) ? 'dialog stuck open' : ''
  }
  const characterOf = (loc) => loc.getAttribute('data-character', { timeout: WAIT_MS })
  const focusedTestId = () => page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-testid') ?? null)
  const openFromPlus = async () => {
    await PLUS.click({ timeout: WAIT_MS })
    return until(visible(DIALOG, 'create-bot-dialog'))
  }

  const check = async (id, body, gate = true) => {
    const reason = gate ? await body().catch(short) : 'dialog did not open'
    if (reason) { checks[id] = reason; failures.push(id) } else checks[id] = 'pass'
    return !reason
  }

  const B = (await listBots()).map((bot) => bot.id)
  let C = null

  const opened = await check('plus-opens', async () => {
    const open = await openFromPlus()
    if (open) return open
    for (const [loc, what] of [[NAME, 'create-bot-name'], [SUBMIT, 'create-bot-submit']]) {
      if (!await loc.isVisible()) return `${what} not visible`
    }
    for (const id of ['create-bot-task', 'create-bot-label', 'create-bot-more', 'create-bot-template']) {
      if (await DIALOG.locator(`[data-testid="${id}"]`).count()) return `${id} present in the name-only dialog`
    }
    if (!await PREVIEW.isVisible()) return 'create-bot-preview avatar not visible'
    const box = await PREVIEW.boundingBox()
    if (!box) return 'create-bot-preview avatar has no box'
    if (Math.abs(box.width - 80) > 1 || Math.abs(box.height - 80) > 1) return `preview ${box.width}x${box.height}, expected 80±1`
    if ((await PREVIEW.locator('svg').count()) < 1) return 'preview has no svg'
    if (!/^orb-/.test(await characterOf(PREVIEW) ?? '')) return 'preview avatar has no orb character'
    if (await page.locator('.sidebar-create-menu, [data-testid="bots-new"]').count()) return 'the + still shows a menu'
    return ''
  })

  await check('empty-blocked', async () => {
    for (const value of ['', '   ']) {
      await NAME.fill(value, { timeout: WAIT_MS })
      if (await SUBMIT.isEnabled({ timeout: WAIT_MS })) await SUBMIT.click({ timeout: WAIT_MS })
      await pause(500)
      if (!await DIALOG.isVisible()) return `dialog closed for name ${JSON.stringify(value)}`
      const ids = (await listBots()).map((bot) => bot.id)
      if (ids.length !== B.length || !B.every((id) => ids.includes(id))) return `bot added for name ${JSON.stringify(value)}`
    }
    return ''
  }, opened)

  await check('create-opens-chat', async () => {
    await NAME.fill('Created Bot', { timeout: WAIT_MS })
    await SUBMIT.click({ timeout: WAIT_MS })
    const shut = await until(closed)
    if (shut) return shut
    const added = await until(async () => {
      const list = await listBots()
      const fresh = list.filter((bot) => !B.includes(bot.id))
      if (fresh.length !== 1 || list.length !== B.length + 1) return `${fresh.length} new bots, ${list.length} total, expected 1 new and ${B.length + 1} total`
      C = fresh[0]
      return ''
    })
    if (added) return added
    if (C.name !== 'Created Bot') return `name ${JSON.stringify(C.name)}, expected 'Created Bot'`
    if (C.label) return `label ${JSON.stringify(C.label)}, expected none`
    const row = page.locator(ROW_SEL(C.id))
    if ((await row.count()) !== 1) return `${await row.count()} sidebar rows for the new bot, expected 1`
    if (!await row.isVisible()) return 'new bot row not visible'
    if (await page.locator('[data-testid="bots-title-pill"]').count()) return 'a title pill is rendered, expected none'
    const named = await until(async () => (await page.locator(`${EMPTY_SEL} h2`).innerText({ timeout: WAIT_MS })).includes('Created Bot') ? '' : 'empty thread lacks Created Bot')
    if (named) return named
    return until(async () => await focusedTestId() === 'bots-input' ? '' : 'focus is not on bots-input')
  }, opened)

  await check('stored-character', async () => {
    if (!C) return 'no created bot'
    const a = C.avatar
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return `avatar ${JSON.stringify(a)} is not a plain object`
    if (JSON.stringify(Object.keys(a)) !== '["character"]' || !/^orb-/.test(a.character)) return `avatar ${JSON.stringify(a)}, expected one orb character`
    const row = await characterOf(page.locator(`${ROW_SEL(C.id)} .bot-avatar`).first())
    if (row !== a.character) return `row character ${row}, stored ${a.character}`
    const empty = await characterOf(page.locator(`${EMPTY_SEL} .bot-avatar`).first())
    return empty === a.character ? '' : `empty thread character ${empty}, stored ${a.character}`
  }, opened)

  const shortcutOpens = async () => {
    await page.keyboard.press('ControlOrMeta+n')
    const shown = await until(visible(DIALOG, 'create-bot-dialog'))
    if (shown) return shown
    await page.keyboard.press('Escape')
    return until(closed)
  }

  await check('shortcut-opens', async () => {
    const stuck = await ensureClosed()
    if (stuck) return stuck
    const K = (await listBots()).length
    await page.evaluate(() => globalThis.document.activeElement?.blur())
    const a = await shortcutOpens()
    if (a) return `(a) ${a}`
    if ((await INPUT.count()) === 0 || !await INPUT.isVisible()) return '(b) bots-input absent'
    await INPUT.focus({ timeout: WAIT_MS })
    const b = await shortcutOpens()
    if (b) return `(b) ${b}`
    const count = (await listBots()).length
    return count === K ? '' : `${count} bots after the shortcut, expected ${K}`
  })

  await check('no-photo-upload', async () => {
    const stuck = await ensureClosed()
    if (stuck) return stuck
    const open = await openFromPlus()
    if (open) return open
    await CHANGE.click({ timeout: WAIT_MS })
    const picker = await until(visible(PICKER, 'avatar-picker'))
    if (picker) return picker
    const found = { tabs: await PICKER.getByRole('tab').count(), files: await DIALOG.locator('input[type="file"]').count(), testid: await DIALOG.getByTestId('avatar-picker-file').count() }
    await page.keyboard.press('Escape')
    return found.tabs + found.files + found.testid === 0 ? '' : `photo upload still present: ${JSON.stringify(found)}`
  })

  return { ok: failures.length === 0, evidence: { before: B.length, created: C?.id, checks, failures } }
}
