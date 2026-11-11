// Korean UI: sets uiLanguage 'ko' through settingsSet and reloads, then scans the sidebar and its + menu, the primary
// bot's chat, all five info pane tabs, the New bot dialog and Settings for visible text and aria-label/title/placeholder/alt
// values that still hold English (3+ ASCII letters outside a short allowlist, the vault's own bot names, labels,
// purposes and note titles, URLs and paths). It then sets uiLanguage 'en', reloads and requires an English sidebar.
// UI_KOREAN_REGIONS (comma list of sidebar, chat, info, create, settings) limits the scanned regions. Many surfaces are
// still hard-coded English, so this scenario returns ok:false until rd-i18n-sidebar, rd-i18n-bot-surfaces and
// rd-i18n-settings land; that is the expected result on current code. It only observes and writes no files.

const WAIT_MS = 5_000
const MAX_LISTED = 50
const ALL_REGIONS = ['sidebar', 'chat', 'info', 'create', 'settings']
const NOTES = ['Hello note', 'Argo redesign', 'Argo palette']
const ALLOW_PHRASES = ['Claude Code', 'Claude Desktop']
const ALLOW = new Set([
  'Engram', 'Claude', 'ChatGPT', 'Codex', 'OpenAI', 'Gemini', 'Cosmos', 'Orbit', 'GitHub', 'Obsidian',
  'Chrome', 'Edge', 'Brave', 'Windows', 'Mac', 'MCP', 'CLI', 'API', 'URL', 'JSON',
  'PNG', 'JPG', 'JPEG', 'PDF', 'Cmd', 'Ctrl', 'Shift', 'Alt', 'Esc', 'Enter',
])
const HANGUL = /[\uAC00-\uD7A3]/
const SIDEBAR_SEL = '[data-testid="app-sidebar"]'
const CREATE_SEL = '.app-sidebar [data-testid="sidebar-create"]'
const VIEW_SEL = '[data-testid="bots-view"]'
const PANE_SEL = '[data-testid="bot-info-pane"]'
const DIALOG_SEL = '[role="dialog"][data-testid="create-bot-dialog"]'
const SETTINGS_BUTTON_SEL = '[data-testid="activity-settings"]'
const SETTINGS_SEL = '[data-testid="settings-view"]'

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

// Visible text nodes plus the aria-label, title, placeholder and alt of visible elements under root, minus exclude.
function collect(page, root, exclude = null) {
  return page.evaluate(({ root, exclude }) => {
    const base = globalThis.document.querySelector(root)
    if (!base) return { error: `no ${root}` }
    const visible = (el) => el.checkVisibility({ checkVisibilityCSS: true })
    const excluded = (el) => exclude !== null && el.closest(exclude) !== null
    const whereOf = (el) => {
      const marked = el.closest('[data-testid]')
      return marked ? `[data-testid="${marked.getAttribute('data-testid')}"]` : el.tagName.toLowerCase()
    }
    const seen = new Set()
    const items = []
    const add = (raw, el) => {
      const text = raw.replace(/\s+/g, ' ').trim()
      if (!text) return
      const where = whereOf(el)
      const key = `${text}\n${where}`
      if (seen.has(key)) return
      seen.add(key)
      items.push({ text, where })
    }
    const walker = globalThis.document.createTreeWalker(base, globalThis.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || excluded(el) || el.closest('script, style')) continue
      const option = el.closest('option')
      const shown = option ? option.closest('select') : el
      if (!shown || !visible(shown)) continue
      add(node.nodeValue ?? '', el)
    }
    for (const el of [base, ...base.querySelectorAll('*')]) {
      if (excluded(el) || !visible(el)) continue
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = el.getAttribute(name)
        if (value) add(value, el)
      }
    }
    return { items }
  }, { root, exclude })
}

function isOffending(text, phrases) {
  let rest = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)(?:~?\/|[A-Za-z]:\\)\S+/g, ' ')
  for (const phrase of phrases) rest = rest.split(phrase).join(' ')
  rest = rest.replace(/[A-Za-z]+/g, (token) => (ALLOW.has(token) ? ' ' : token))
  return /[A-Za-z]{3,}/.test(rest)
}

export async function run(page) {
  const regions = (process.env.UI_KOREAN_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = regions.find((name) => !ALL_REGIONS.includes(name))
  if (unknown !== undefined) {
    return { ok: false, evidence: { regions, checks: { regions: `unknown region ${unknown}` }, failures: ['regions'] } }
  }
  const selected = regions.length ? regions : ALL_REGIONS
  const checks = {}
  const failures = []
  const offending = { sidebar: [], chat: [], info: [], create: [], settings: [], en: [] }
  const evidence = { regions: selected, checks, failures, offending }

  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
  const bots = await page.evaluate(async () => {
    await globalThis.engram.settingsSet({ uiLanguage: 'ko' })
    return globalThis.engram.botsList()
  })
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })

  const user = [...NOTES]
  for (const bot of bots) for (const value of [bot.name, bot.label, bot.purpose]) if (typeof value === 'string' && value !== '') user.push(value)
  const phrases = [...user, ...ALLOW_PHRASES].sort((a, b) => b.length - a.length)
  const record = (list, item) => {
    if (list.length < MAX_LISTED) list.push({ text: Array.from(item.text).slice(0, 120).join(''), where: item.where })
  }
  const scan = async (region, root, exclude = null) => {
    const result = await collect(page, root, exclude)
    if (result.error) return result.error
    const bad = result.items.filter((item) => isOffending(item.text, phrases))
    for (const item of bad) record(offending[region], item)
    return bad.length ? `${bad.length} English string(s) in ${root}, first '${bad[0].text}' at ${bad[0].where}` : ''
  }
  const check = async (id, region, body) => {
    if (region !== null && !selected.includes(region)) { checks[id] = 'skipped'; return true }
    const reason = await body().catch(short)
    if (reason) { checks[id] = reason; failures.push(id) } else checks[id] = 'pass'
    return !reason
  }
  const settingsLabel = (want) => until(async () => {
    const label = await page.locator(SETTINGS_BUTTON_SEL).first().getAttribute('aria-label', { timeout: WAIT_MS })
    return label === want ? '' : `activity-settings aria-label is ${JSON.stringify(label)}, expected '${want}'`
  })
  const visibleOf = (sel, what) => until(async () => await page.locator(sel).first().isVisible() ? '' : `${what} not visible`)
  const goneOf = (sel, what) => until(async () => await page.locator(sel).first().isVisible() ? `${what} still visible` : '')

  await check('ko-applied', null, () => settingsLabel('설정'))

  await check('ko-sidebar', 'sidebar', async () => {
    const reasons = [await scan('sidebar', SIDEBAR_SEL)]
    await page.locator(CREATE_SEL).click({ timeout: WAIT_MS })
    try {
      const menu = await visibleOf('[data-testid="bots-new"]', 'bots-new')
      reasons.push(menu || await scan('sidebar', '.sidebar-create-menu'))
    } finally {
      await page.keyboard.press('Escape')
    }
    return reasons.filter(Boolean).join('; ')
  })

  let opened = false
  if (selected.includes('chat') || selected.includes('info')) {
    const primary = bots.find((bot) => bot.primary === true)
    if (primary) {
      opened = !await (async () => {
        await page.locator(`.app-sidebar [data-testid="bot-${primary.id}"]`).first().click({ timeout: WAIT_MS })
        return visibleOf(`${VIEW_SEL} [data-testid="bots-input"]`, 'bots-input')
      })().catch(short)
    }
  }

  await check('ko-chat', 'chat', async () => (opened ? scan('chat', VIEW_SEL, PANE_SEL) : 'chat did not open'))

  await check('ko-info', 'info', async () => {
    if (!opened) return 'chat did not open'
    await page.locator(`${VIEW_SEL} [data-testid="bots-title-pill"]`).click({ timeout: WAIT_MS })
    const shown = await visibleOf(PANE_SEL, 'bot-info-pane')
    if (shown) return shown
    const tabs = page.locator(`${PANE_SEL} [role="tab"]`)
    const count = await tabs.count()
    const reasons = count === 5 ? [] : [`${count} info pane tabs, expected 5`]
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click({ timeout: WAIT_MS })
      reasons.push(await scan('info', PANE_SEL))
    }
    await page.keyboard.press('Escape')
    reasons.push(await goneOf(PANE_SEL, 'bot-info-pane'))
    return reasons.filter(Boolean).join('; ')
  })

  await check('ko-create', 'create', async () => {
    await page.locator(CREATE_SEL).click({ timeout: WAIT_MS })
    await page.locator('[data-testid="bots-new"]').first().click({ timeout: WAIT_MS })
    const shown = await visibleOf(DIALOG_SEL, 'create-bot-dialog')
    if (shown) return shown
    const reason = await scan('create', DIALOG_SEL)
    await page.keyboard.press('Escape')
    return [reason, await goneOf(DIALOG_SEL, 'create-bot-dialog')].filter(Boolean).join('; ')
  })

  await check('ko-settings', 'settings', async () => {
    await page.locator(SETTINGS_BUTTON_SEL).first().click({ timeout: WAIT_MS })
    const shown = await visibleOf(SETTINGS_SEL, 'settings-view')
    if (shown) return shown
    const reason = await scan('settings', SETTINGS_SEL)
    await page.keyboard.press('Escape')
    return [reason, await goneOf(SETTINGS_SEL, 'settings-view')].filter(Boolean).join('; ')
  })

  await check('en-restored', null, async () => {
    await page.evaluate(() => globalThis.engram.settingsSet({ uiLanguage: 'en' }))
    await page.reload()
    await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
    const label = await settingsLabel('Settings')
    const result = await collect(page, SIDEBAR_SEL)
    if (result.error) return [label, result.error].filter(Boolean).join('; ')
    const korean = result.items.filter((item) => HANGUL.test(item.text))
    for (const item of korean) record(offending.en, item)
    return [label, korean.length ? `${korean.length} Korean string(s) in the sidebar, first '${korean[0].text}'` : ''].filter(Boolean).join('; ')
  })

  return { ok: failures.length === 0, evidence }
}
