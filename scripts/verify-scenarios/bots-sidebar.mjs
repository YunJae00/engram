// Bots sidebar: seeds six bots, two sections, a pin, a label, a hidden bot and two transcripts through the running
// app, then runs checks C1-C14 in order: hero, tree rows, row text, order, hidden group, old bot, arrow keys, F2,
// Shift+F10 menu, search, and the Hide / Move / Make primary menu items read back through botsList and sidebarLayout.
// Until rd-sidebar-bots, rd-sidebar-context-menu and rd-a11y-sidebar-keys land, the hero, role=tree / treeitem rows
// and menu items do not exist and this scenario returns ok:false with evidence naming each failed check; that is the
// expected result on current code.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const WAIT_MS = 5_000
const NAMES = ['Pin Bot', 'Alpha Bot', 'Beta Bot', 'Loose Bot', 'Old Bot', 'Hidden Bot']
const VISIBLE = NAMES.filter((name) => name !== 'Hidden Bot')
const CHAT_TEXT = 'zqchat ping from loose'
const TIME_PATTERNS = [/\b\d{1,2}:\d{2}\b/, /\b\d+\s*(s|m|h|d|w|min|mins|minutes?|hours?|days?|weeks?)\s+ago\b/i, /\b(just now|yesterday|today)\b/i]

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

async function seed(page, paths) {
  const ids = await page.evaluate(async (names) => {
    const api = globalThis.engram
    await api.settingsSet({ uiLanguage: 'en' })
    const purposes = { 'Beta Bot': 'Tracks zqpurpose work' }
    const ids = {}
    for (const name of names) ids[name] = (await api.botCreate({ name, purpose: purposes[name] ?? `Seeded ${name}` })).id
    await api.botUpdate(ids['Alpha Bot'], { label: 'zqlabel' })
    await api.botUpdate(ids['Hidden Bot'], { hidden: true })
    await api.sidebarLayout('chat')
    await api.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Section A' } })
    const layout = await api.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Section B' } })
    const folder = (name) => layout.chat.folders.find((f) => f.name === name).id
    await api.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: ids['Alpha Bot'], folder: folder('Section A') } })
    await api.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: ids['Beta Bot'], folder: folder('Section B') } })
    await api.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id: ids['Pin Bot'], pinned: true } })
    ids.Engram = (await api.botsList()).find((b) => b.primary && b.name === 'Engram')?.id
    return ids
  }, NAMES)
  const chats = join(paths.cache, 'bot-chats')
  await mkdir(chats, { recursive: true })
  const line = (text, at) => `${JSON.stringify({ role: 'user', text, at })}\n`
  await appendFile(join(chats, `${ids['Loose Bot']}.jsonl`), line(CHAT_TEXT, new Date(Date.now() - 10 * 60_000).toISOString()))
  await appendFile(join(chats, `${ids['Old Bot']}.jsonl`), line('old conversation', new Date(Date.now() - 72 * 3600_000).toISOString()))
  return ids
}

// Page-side helpers: Playwright's isVisible rule (non-empty box, not visibility:hidden) and element identity.
function installHelpers(page) {
  return page.evaluate(() => {
    const tree = () => globalThis.document.querySelector('.app-sidebar [role="tree"]')
    const row = (id) => globalThis.document.querySelector(`[data-testid="bot-${id}"]`)
    const ti = (id) => row(id)?.closest('[role="treeitem"]') ?? null
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && globalThis.getComputedStyle(el).visibility !== 'hidden' }
    const active = () => globalThis.document.activeElement?.closest('[role="treeitem"]') ?? null
    globalThis.__botsSidebar = { tree, row, ti, vis, active }
  })
}

export async function run(page, { paths }) {
  const ids = await seed(page, paths)
  await page.reload()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
  await installHelpers(page)

  const checks = {}
  const failures = []
  const evidence = { seeded: ids, checks, failures }
  const SIDEBAR = page.locator('.app-sidebar')
  const TREE = SIDEBAR.locator('[role="tree"]').first()
  const ROW = (name) => page.locator(`[data-testid="bot-${ids[name]}"]`).first()
  const HEADER = (text) => TREE.getByText(text, { exact: true }).first()
  const GROUP = TREE.getByText(/^Hidden bots \(\d+\)$/).first()
  const HERO = page.locator('.sidebar-primary').first()
  const SEARCH = SIDEBAR.getByRole('textbox', { name: /^Search/ }).first()
  const MENU = (name) => page.locator(`[role="menu"][aria-label="Options for ${name}"], [role="dialog"][aria-label="Options for ${name}"]`)
  const MENU_BUTTON = (name) => SIDEBAR.locator(`button[aria-label="Options for ${name}"]`).first()
  const ITEM = (menu, label) => menu.locator('[role="menuitem"], button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first()
  const top = (locator) => locator.evaluate((node) => node.getBoundingClientRect().top, null, { timeout: WAIT_MS })
  const noTree = async () => (await TREE.count()) === 0 ? 'no role=tree' : ''
  const inPage = (fn, arg) => page.evaluate(fn, arg)
  const bots = () => page.evaluate(() => globalThis.engram.botsList())
  const groupText = async () => ((await GROUP.textContent({ timeout: WAIT_MS })) ?? '').trim()
  const focusPin = () => inPage((id) => { const ti = globalThis.__botsSidebar.ti(id); ti?.focus(); return !!ti }, ids['Pin Bot'])
  const activeIsPin = () => inPage((id) => globalThis.__botsSidebar.active() === globalThis.__botsSidebar.ti(id), ids['Pin Bot'])

  const check = async (id, body) => {
    const reason = ids.Engram ? await body().catch(short) : 'seeding found no primary Engram bot'
    if (reason) { checks[id] = reason; failures.push(id) } else checks[id] = 'pass'
  }

  // C1
  await check('hero', async () => {
    if (!await HERO.isVisible()) return 'no visible .sidebar-primary'
    if (!(await HERO.innerText()).includes('Engram')) return 'hero text lacks Engram'
    const box = await page.locator('.sidebar-primary .bot-avatar').first().boundingBox({ timeout: WAIT_MS })
    if (!box || Math.abs(box.width - 64) > 1 || Math.abs(box.height - 64) > 1) return `hero avatar ${box ? `${box.width}x${box.height}` : 'missing'}, expected 64x64`
    if (!await page.locator('.sidebar-primary .bot-avatar-primary').first().isVisible()) return 'no visible .bot-avatar-primary'
    if (await noTree()) return 'no role=tree'
    if (await TREE.locator(`[data-testid="bot-${ids.Engram}"]`).count()) return 'primary Engram is listed in the tree'
  })

  // C2
  await check('tree-rows', async () => {
    if (await noTree()) return 'no role=tree'
    for (const name of VISIBLE) {
      if (!await ROW(name).isVisible()) return `${name} row not visible`
      if (!await inPage((id) => { const t = globalThis.__botsSidebar.tree(), ti = globalThis.__botsSidebar.ti(id); return !!(t && ti && t.contains(ti)) }, ids[name])) return `${name} row is not a treeitem inside the tree`
    }
  })

  // C3
  await check('row-text', async () => {
    for (const name of VISIBLE) {
      const row = await inPage((id) => {
        const el = globalThis.__botsSidebar.row(id)
        if (!el) return null
        return {
          text: el.innerText,
          time: [...el.querySelectorAll('time')].some(globalThis.__botsSidebar.vis),
          titleDigit: [el, ...el.querySelectorAll('[title]')].some((node) => /\d/.test(node.getAttribute('title') ?? '')),
        }
      }, ids[name])
      if (!row) return `${name} has no row`
      if (!row.text.includes(name)) return `${name} row text lacks its name`
      if (name === 'Alpha Bot' && !row.text.includes('zqlabel')) return 'Alpha Bot row text lacks its label'
      if (name === 'Loose Bot' && !row.text.includes(CHAT_TEXT)) return 'Loose Bot row text lacks its last message'
      if (row.time) return `${name} row shows a visible <time>`
      const shown = TIME_PATTERNS.find((pattern) => pattern.test(row.text))
      if (shown) return `${name} row text shows a time (${shown})`
      if ((name === 'Loose Bot' || name === 'Old Bot') && !row.titleDigit) return `${name} row has no title tooltip with the time`
    }
  })

  // C4
  await check('order', async () => {
    if (await noTree()) return 'no role=tree'
    const chain = [['Pin row', ROW('Pin Bot')], ['Section A', HEADER('Section A')], ['Alpha row', ROW('Alpha Bot')], ['Section B', HEADER('Section B')], ['Beta row', ROW('Beta Bot')], ['Loose row', ROW('Loose Bot')], ['Old row', ROW('Old Bot')], ['Hidden group', GROUP]]
    const tops = []
    for (const [label, locator] of chain) tops.push([label, await top(locator)])
    for (let i = 1; i < tops.length; i++) if (!(tops[i - 1][1] < tops[i][1])) return `${tops[i - 1][0]} is not above ${tops[i][0]}`
    const text = await groupText()
    if (text !== 'Hidden bots (1)') return `group reads "${text}", expected "Hidden bots (1)"`
  })

  // C5
  await check('hidden-group', async () => {
    if (await noTree()) return 'no role=tree'
    const hidden = ROW('Hidden Bot')
    if (await hidden.isVisible()) return 'Hidden Bot row visible before opening the group'
    await GROUP.click({ timeout: WAIT_MS })
    const opened = await until(async () => (await hidden.isVisible() && await top(hidden) > await top(GROUP)) ? '' : 'Hidden Bot row not visible below the group after opening it')
    if (opened) return opened
    await GROUP.click({ timeout: WAIT_MS })
    return until(async () => await hidden.isVisible() ? 'Hidden Bot row still visible after closing the group' : '')
  })

  // C6
  await check('old-bot', async () => {
    if (!await ROW('Old Bot').isVisible()) return 'Old Bot row not visible'
    if (await page.locator('[data-testid="sidebar-earlier"]').count()) return 'sidebar-earlier button still rendered'
  })

  // C7
  await check('keys-arrows', async () => {
    if (await noTree()) return 'no role=tree'
    if (!await focusPin()) return 'Pin Bot row is not inside a treeitem'
    await inPage((id) => {
      const s = globalThis.__botsSidebar
      s.visibleItems = [...s.tree().querySelectorAll('[role="treeitem"]')].filter(s.vis)
      s.next = s.visibleItems[s.visibleItems.indexOf(s.ti(id)) + 1]
    }, ids['Pin Bot'])
    await page.keyboard.press('ArrowDown')
    const down = await until(async () => await inPage(() => globalThis.__botsSidebar.active() === globalThis.__botsSidebar.next) ? '' : 'ArrowDown did not focus the next visible treeitem')
    if (down) return down
    await page.keyboard.press('ArrowUp')
    return until(async () => await activeIsPin() ? '' : 'ArrowUp did not return focus to Pin Bot')
  })

  // C8
  await check('keys-f2', async () => {
    if (await noTree()) return 'no role=tree'
    if (!await focusPin()) return 'Pin Bot row is not inside a treeitem'
    await page.keyboard.press('F2')
    const editing = await until(async () => await inPage(() => {
      const el = globalThis.document.activeElement
      return el?.tagName === 'INPUT' && !!globalThis.__botsSidebar.tree()?.contains(el) && el.value === 'Pin Bot'
    }) ? '' : 'F2 did not focus a tree input holding "Pin Bot"')
    if (editing) return editing
    await page.keyboard.press('Escape')
    const closed = await until(async () => await inPage(() => !!globalThis.__botsSidebar.tree()?.querySelector('input')) ? 'an input remains in the tree after Escape' : '')
    if (closed) return closed
    if ((await bots()).find((b) => b.id === ids['Pin Bot'])?.name !== 'Pin Bot') return 'Escape changed the stored name of Pin Bot'
  })

  // C9
  await check('keys-menu', async () => {
    if (await noTree()) return 'no role=tree'
    if (!await focusPin()) return 'Pin Bot row is not inside a treeitem'
    await page.keyboard.press('Shift+F10')
    const opened = await until(async () => await MENU('Pin Bot').first().isVisible() ? '' : 'Shift+F10 did not open the Pin Bot menu')
    if (opened) return opened
    await page.keyboard.press('Escape')
    return until(async () => {
      if (await MENU('Pin Bot').count()) return 'menu still open after Escape'
      return await activeIsPin() ? '' : 'focus did not return to Pin Bot after Escape'
    })
  })

  // C10
  await check('search', async () => {
    const queries = [['zqlabel', 'Alpha Bot'], ['zqpurpose', 'Beta Bot'], ['zqchat', 'Loose Bot'], ['Alpha', 'Alpha Bot'], ['zqnone', null]]
    try {
      for (const [query, expected] of queries) {
        await SEARCH.fill(query, { timeout: WAIT_MS })
        let shown = []
        const reason = await until(async () => {
          shown = []
          for (const name of NAMES) if (await ROW(name).isVisible()) shown.push(name)
          return shown.length === (expected ? 1 : 0) && (!expected || shown[0] === expected) ? '' : 'mismatch'
        })
        if (reason) return `search "${query}" shows ${JSON.stringify(shown)}, expected ${JSON.stringify(expected ? [expected] : [])}`
        await SEARCH.fill('', { timeout: WAIT_MS })
      }
    } finally {
      await SEARCH.fill('', { timeout: WAIT_MS }).catch(() => undefined)
    }
  })

  // C11
  await check('menu-hide', async () => {
    if (await noTree()) return 'no role=tree'
    await MENU_BUTTON('Loose Bot').click({ timeout: WAIT_MS })
    await ITEM(MENU('Loose Bot'), 'Hide from sidebar').click({ timeout: WAIT_MS })
    const stored = await until(async () => {
      if ((await bots()).find((b) => b.id === ids['Loose Bot'])?.hidden !== true) return 'botsList does not mark Loose Bot hidden'
      const text = await groupText()
      return text === 'Hidden bots (2)' ? '' : `group reads "${text}", expected "Hidden bots (2)"`
    })
    if (stored) return stored
    const row = ROW('Loose Bot')
    if (await row.isVisible() && !(await top(row) > await top(GROUP))) return 'Loose Bot row still listed above the hidden group'
  })

  // C12
  await check('menu-move', async () => {
    if (await noTree()) return 'no role=tree'
    await MENU_BUTTON('Beta Bot').click({ timeout: WAIT_MS })
    await ITEM(MENU('Beta Bot'), 'Move to Section A').click({ timeout: WAIT_MS })
    const stored = await until(async () => {
      const layout = await page.evaluate(() => globalThis.engram.sidebarLayout('chat'))
      const chat = layout.chat ?? layout
      const folder = chat.folders.find((f) => f.name === 'Section A')?.id
      return folder && chat.items.find((item) => item.id === ids['Beta Bot'])?.folder === folder ? '' : 'sidebarLayout does not put Beta Bot in Section A'
    })
    if (stored) return stored
    const beta = await top(ROW('Beta Bot'))
    if (!(beta > await top(HEADER('Section A')))) return 'Beta Bot row is not below Section A'
    if (await HEADER('Section B').isVisible() && !(beta < await top(HEADER('Section B')))) return 'Beta Bot row is not above Section B'
  })

  // C13
  await check('menu-primary', async () => {
    if (await noTree()) return 'no role=tree'
    await MENU_BUTTON('Pin Bot').click({ timeout: WAIT_MS })
    await ITEM(MENU('Pin Bot'), 'Make primary').click({ timeout: WAIT_MS })
    return until(async () => {
      const primary = (await bots()).filter((b) => b.primary).map((b) => b.id)
      if (primary.length !== 1 || primary[0] !== ids['Pin Bot']) return `botsList primary is ${JSON.stringify(primary)}, expected only Pin Bot`
      if (!(await HERO.innerText({ timeout: WAIT_MS })).includes('Pin Bot')) return 'hero does not show Pin Bot'
      if (await TREE.locator(`[data-testid="bot-${ids['Pin Bot']}"]`).count()) return 'Pin Bot is still listed in the tree'
      return await TREE.locator(`[data-testid="bot-${ids.Engram}"]`).first().isVisible() ? '' : 'Engram row not visible in the tree'
    })
  })

  // C14
  await check('status-dots', async () => {
    if (await noTree()) return 'no role=tree'
    const dots = await inPage(() => {
      const tree = globalThis.__botsSidebar.tree()
      return [...tree.querySelectorAll('[role="img"]')].filter((el) => el.closest('[role="treeitem"]')).map((el) => {
        const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => globalThis.document.getElementById(id)?.textContent ?? '').join(' ')
        return `${el.getAttribute('aria-label') ?? ''} ${labelled}`.trim()
      })
    })
    evidence.statusDots = dots.length
    const unnamed = dots.filter((name) => !name).length
    if (unnamed) return `${unnamed} of ${dots.length} status indicators have no accessible name`
  })

  return { ok: failures.length === 0, evidence }
}
