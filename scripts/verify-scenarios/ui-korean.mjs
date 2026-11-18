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
    const menus = await page.locator('.sidebar-create-menu, [data-testid="bots-new"], [data-testid="sidebar-menu"]').count()
    if (menus) reasons.push(`${menus} sidebar menu element(s), expected none`)
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
    const reasons = []
    const pills = await page.locator('[data-testid="bots-title-pill"]').count()
    if (pills) reasons.push(`${pills} bots-title-pill element(s), expected none`)
    const panes = await page.locator(PANE_SEL).count()
    if (panes) reasons.push(`${panes} bot-info-pane element(s), expected none`)
    const count = await page.locator(`${VIEW_SEL} [role="tab"], ${VIEW_SEL} [role="tablist"]`).count()
    if (count) reasons.push(`${count} tab elements in the chat, expected none`)
    await page.locator(`${VIEW_SEL} [data-testid="bots-input"]`).focus({ timeout: WAIT_MS })
    await page.keyboard.press('Escape')
    reasons.push(await visibleOf(`${VIEW_SEL} [data-testid="bots-input"]`, 'bots-input'))
    return reasons.filter(Boolean).join('; ')
  })

  await check('ko-create', 'create', async () => {
    await page.locator(CREATE_SEL).click({ timeout: WAIT_MS })
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
