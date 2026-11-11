// Bot create: forces the English UI, then runs checks N1-N6 in order: + opens the New bot dialog with name, label,
// template, first-task fields and a 96px avatar preview; an empty or blank name creates nothing; Create adds exactly one
// bot, opens its chat with the composer focused and keeps the previewed character; Cmd/Ctrl+N opens the dialog; the
// Photo tab uploads a PNG that becomes the bot's avatar. Until rd-create-bot-dialog, rd-create-shortcut and
// rd-avatar-picker land, the dialog, shortcut and picker do not exist and this scenario returns ok:false with evidence
// naming the failed checks; that is the expected result on current code.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const WAIT_MS = 5_000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const PLUS_SEL = '.app-sidebar [data-testid="sidebar-create"]'
const NEW_ITEM_SEL = '[data-testid="bots-new"]'
const DIALOG_SEL = '[role="dialog"][data-testid="create-bot-dialog"]'
const PREVIEW_SEL = '[data-testid="create-bot-preview"] .bot-avatar'
const PICKER_SEL = '[data-testid="avatar-picker"]'
const INPUT_SEL = '[data-testid="bots-input"]'
const PILL_NAME_SEL = '[data-testid="bots-view"] [data-testid="bots-title-pill"] .bots-title-pill-name'
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

export async function run(page, { paths }) {
  await page.evaluate(() => globalThis.engram.settingsSet({ uiLanguage: 'en' }))
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const checks = {}
  const failures = []
  const PLUS = page.locator(PLUS_SEL)
  const NEW_ITEM = page.locator(NEW_ITEM_SEL)
  const DIALOG = page.locator(DIALOG_SEL)
  const NAME = DIALOG.locator('[data-testid="create-bot-name"]')
  const LABEL = DIALOG.locator('[data-testid="create-bot-label"]')
  const TEMPLATE = DIALOG.locator('[data-testid="create-bot-template"]')
  const MORE = DIALOG.locator('[data-testid="create-bot-more"]')
  const openMore = async () => { if (await MORE.getAttribute('open', { timeout: WAIT_MS }) === null) await MORE.locator('summary').click({ timeout: WAIT_MS }) }
  const TASK = DIALOG.locator('[data-testid="create-bot-task"]')
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
  const fillOf = (loc) => loc.getAttribute('fill', { timeout: WAIT_MS })
  const focusedTestId = () => page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-testid') ?? null)
  const openFromPlus = async () => {
    await PLUS.click({ timeout: WAIT_MS })
    const item = await until(visible(NEW_ITEM, 'bots-new'))
    if (item) return item
    await NEW_ITEM.click({ timeout: WAIT_MS })
    return until(visible(DIALOG, 'create-bot-dialog'))
  }

  const check = async (id, body, gate = true) => {
    const reason = gate ? await body().catch(short) : 'dialog did not open'
    if (reason) { checks[id] = reason; failures.push(id) } else checks[id] = 'pass'
    return !reason
  }

  const B = (await listBots()).map((bot) => bot.id)
  let FILL = null
  let C = null
  let P = null

  // N1
  const opened = await check('plus-opens', async () => {
    const open = await openFromPlus()
    if (open) return open
    for (const [loc, what] of [[NAME, 'create-bot-name'], [TASK, 'create-bot-task'], [SUBMIT, 'create-bot-submit'], [MORE, 'create-bot-more']]) {
      if (!await loc.isVisible()) return `${what} not visible`
    }
    for (const [loc, what] of [[LABEL, 'create-bot-label'], [TEMPLATE, 'create-bot-template']]) {
      if (await loc.isVisible()) return `${what} visible before More options is opened`
    }
    if (!await PREVIEW.isVisible()) return 'create-bot-preview avatar not visible'
    const box = await PREVIEW.boundingBox()
    if (!box) return 'create-bot-preview avatar has no box'
    if (Math.abs(box.width - 96) > 1 || Math.abs(box.height - 96) > 1) return `preview ${box.width}x${box.height}, expected 96±1`
    if ((await PREVIEW.locator('svg').count()) < 1) return 'preview has no svg'
    const fill = await fillOf(PREVIEW.locator('.bot-avatar-body').first())
    if (!fill?.trim()) return 'preview .bot-avatar-body has no fill'
    FILL = fill
    await openMore()
    for (const [loc, what] of [[LABEL, 'create-bot-label'], [TEMPLATE, 'create-bot-template']]) {
      if (!await loc.isVisible()) return `${what} not visible after More options is opened`
    }
    return ''
  })

  // N2
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

  // N3
  await check('create-opens-chat', async () => {
    await NAME.fill('Created Bot', { timeout: WAIT_MS })
    await openMore()
    await LABEL.fill('zq label', { timeout: WAIT_MS })
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
    if (C.label !== 'zq label') return `label ${JSON.stringify(C.label)}, expected 'zq label'`
    const row = page.locator(ROW_SEL(C.id))
    if ((await row.count()) !== 1) return `${await row.count()} sidebar rows for the new bot, expected 1`
    if (!await row.isVisible()) return 'new bot row not visible'
    const pill = await until(async () => (await page.locator(PILL_NAME_SEL).innerText({ timeout: WAIT_MS })).includes('Created Bot') ? '' : 'title pill lacks Created Bot')
    if (pill) return pill
    return until(async () => await focusedTestId() === 'bots-input' ? '' : 'focus is not on bots-input')
  }, opened)

  // N4
  await check('kept-character', async () => {
    if (!C) return 'no created bot'
    const a = C.avatar
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return `avatar ${JSON.stringify(a)} is not a plain object`
    if (JSON.stringify(Object.keys(a).sort()) !== '["accessory","body","face","palette"]') return `avatar keys ${JSON.stringify(Object.keys(a))}`
    if (!Object.values(a).every(Number.isInteger)) return `avatar values ${JSON.stringify(a)} are not all integers`
    if (FILL === null) return 'no preview'
    const fill = await fillOf(page.locator(`${ROW_SEL(C.id)} .bot-avatar-body`).first())
    return fill === FILL ? '' : `row fill ${fill}, preview fill ${FILL}`
  }, opened)

  const shortcutOpens = async () => {
    await page.keyboard.press('ControlOrMeta+n')
    const shown = await until(visible(DIALOG, 'create-bot-dialog'))
    if (shown) return shown
    await page.keyboard.press('Escape')
    return until(closed)
  }

  // N5
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

  // N6
  await check('photo-upload', async () => {
    const stuck = await ensureClosed()
    if (stuck) return stuck
    const open = await openFromPlus()
    if (open) return open
    await NAME.fill('Photo Bot', { timeout: WAIT_MS })
    await CHANGE.click({ timeout: WAIT_MS })
    const picker = await until(visible(PICKER, 'avatar-picker'))
    if (picker) return picker
    const tab = PICKER.getByRole('tab', { name: 'Photo', exact: true })
    await tab.click({ timeout: WAIT_MS })
    const selected = await until(async () => await tab.getAttribute('aria-selected', { timeout: WAIT_MS }) === 'true' ? '' : 'Photo tab not aria-selected')
    if (selected) return selected
    await PICKER.locator('input[type="file"]').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG }, { timeout: WAIT_MS })
    await SUBMIT.click({ timeout: WAIT_MS })
    const shut = await until(closed)
    if (shut) return shut
    const found = await until(async () => {
      P = (await listBots()).find((bot) => bot.name === 'Photo Bot') ?? null
      return P ? '' : 'no bot named Photo Bot'
    })
    if (found) return found
    const a = P.avatar
    const want = `bot-avatars/${P.id}.png`
    if (a === null || typeof a !== 'object' || Array.isArray(a) || JSON.stringify(Object.keys(a)) !== '["image"]' || a.image !== want) {
      return `avatar ${JSON.stringify(a)}, expected {"image":"${want}"}`
    }
    const buf = await readFile(join(paths.cache, 'bot-avatars', `${P.id}.png`))
    return buf.equals(PNG) ? '' : 'stored avatar bytes differ from the uploaded PNG'
  })

  return { ok: failures.length === 0, evidence: { before: B.length, created: { created: C?.id, photo: P?.id }, checks, failures } }
}
