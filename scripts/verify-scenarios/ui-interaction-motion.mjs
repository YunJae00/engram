/* global window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, Element, KeyboardEvent, innerWidth, innerHeight */
export async function run(page, { expect, openActivity, app }) {
  const evidence = [], errors = []
  try {
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await openActivity(page, 'bots')
  const names = ['Motion alpha', 'Motion beta', 'Motion gamma', 'Motion delta', 'Motion epsilon']
  const [bot, b, c, d, e] = await page.evaluate(async names => { const made = []; for (const name of names) made.push(await window.engram.botCreate({ name })); return made }, names)
  const row = id => `[data-testid="bot-${id}"]`
  await expect(page.locator(row(e.id))).toBeVisible()
  const create = '[data-testid="sidebar-create"]'
  const fresh = '[data-testid="bots-new"]'
  const folder = '[aria-label="New chat folder"]'
  const form = '.sidebar-folder-create'
  const menu = '.sidebar-create-menu'
  const input = '[aria-label="Folder name"]'
  const record = (label, detail = {}) => evidence.push({ label, ...detail, pass: detail.pass ?? true })
  const click = selector => page.evaluate(selector => document.querySelector(selector).click(), selector)
  const center = async selector => { const box = await page.locator(selector).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }
  const mouse = async selector => page.mouse.click(...await center(selector))
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot], [data-motion-state="exit"]:not(.sidebar-create-menu)') && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity), undefined, { timeout: 2000 })
  const shown = async one => { await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator('[data-testid="bots-thread"] .bots-hint')).toContainText(one.name) }
  const welcome = async () => { await expect(page.getByTestId('comet-welcome')).toBeVisible(); await expect(page.locator('.bots-row.active')).toHaveCount(0) }
  const usable = async scope => { const box = page.locator(`${scope} textarea`); await box.fill('Ready after navigation'); await expect(box).toHaveValue('Ready after navigation'); await box.fill('') }
  const residue = () => page.evaluate(() => ({ snapshots: document.querySelectorAll('[data-chat-snapshot]').length, owned: document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).length }))
  const menuClosed = async () => {
    await expect(page.locator(menu)).toBeHidden()
    expect(await page.locator(menu).evaluate(node => node.inert && node.getAttribute('aria-hidden') === 'true' && !node.contains(document.activeElement) && document.querySelectorAll('[data-testid="bots-new"]').length === 1 && document.querySelector('[data-testid="bots-new"]') === window.motionNew && !window.motionNew.disabled)).toBe(true)
  }
  await page.evaluate(() => { window.motionNew = document.querySelector('[data-testid="bots-new"]') })
  await menuClosed()
  record('create-menu-retained-before-first-open')
  // With a target the probe samples that node's animations; without one it samples the owned session animations by id.
  const startProbe = (target, property = 'opacity') => page.evaluate(({ target, property }) => {
    const probe = window.motionProbe = { found: [], clicks: [], snapshots: 0, stopped: false }
    const owned = () => document.getAnimations().filter(animation => animation.id.startsWith('chat-session-'))
    const box = node => { const rect = node?.getBoundingClientRect(); return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join() : '' }
    probe.click = event => probe.clicks.push({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, box: box(document.querySelector('.bots-view :is(.bots-thread, .comet-welcome):not([data-chat-snapshot])')) })
    document.addEventListener('click', probe.click, true)
    const scan = () => {
      if (probe.stopped) return
      probe.snapshots = Math.max(probe.snapshots, document.querySelectorAll('[data-chat-snapshot]').length)
      for (const animation of target ? document.querySelector(target)?.getAnimations() ?? [] : owned()) {
        if (probe.found.some(record => record.animation === animation)) continue
        const effect = animation.effect, timing = effect.getTiming(), node = effect.target
        if (animation.transitionProperty && animation.transitionProperty !== property) continue
        animation.pause()
        const samples = [0, .25, .75, 1].map(fraction => {
          animation.currentTime = Number(timing.duration) * fraction
          const style = getComputedStyle(node)
          return property === 'grid-template-rows' ? parseFloat(style.height) : Number(style.opacity)
        })
        animation.currentTime = 0
        probe.found.push({ animation, box: box(node), id: animation.id, duration: timing.duration, easing: timing.easing === 'linear' ? effect.getKeyframes()[0]?.easing : timing.easing, samples, connected: node.isConnected, snapshot: node.matches('[data-chat-snapshot]'), keyed: !!node.closest('.bots-chat'), parent: node.parentElement?.className, surface: node.dataset.testid ?? '' })
        animation.play()
      }
      probe.frame = requestAnimationFrame(scan)
    }
    scan()
  }, { target, property })
  const stopProbe = () => page.evaluate(() => {
    const probe = window.motionProbe
    probe.stopped = true; cancelAnimationFrame(probe.frame); document.removeEventListener('click', probe.click, true)
    return { found: probe.found.map(record => ({ ...record, animation: undefined })), clicks: probe.clicks, snapshots: probe.snapshots }
  })
  const eased = (m, sign) => {
    const [start, quarter, later, end] = m.samples, range = end - start
    return m.duration >= 120 && m.duration <= 260 && m.easing !== 'linear' && Math.abs(range) > .5 && Math.sign(range) === sign && Math.abs((quarter - start) / range - .25) > .05 && quarter !== later
  }
  async function measure(target, direction, preference, action, property = 'opacity', persistent = false) {
    await settle()
    await startProbe(target, property)
    await action()
    await frames()
    if (preference === 'no-preference') await page.waitForFunction(() => window.motionProbe.found.length > 0, undefined, { timeout: 800 }).catch(() => {})
    const { found } = await stopProbe()
    const retained = preference === 'reduce' && direction === 'exit' && !persistent ? await page.locator(target).count() : 0
    const pass = preference === 'reduce' ? !retained && found.every(m => m.duration <= 1) : found.some(m => eased(m, direction === 'entry' ? 1 : -1))
    evidence.push({ target, direction, preference, measurements: found, retained, pass })
    await settle()
    if (direction === 'exit' && !persistent) await expect(page.locator(target)).toHaveCount(0, { timeout: 1000 })
  }
  // One trusted mouse click; surface names the incoming live surface, or null when no session motion may run.
  async function session(label, preference, selector, control, surface) {
    await settle()
    await startProbe(null)
    await mouse(selector)
    if (preference === 'no-preference' && surface) await page.waitForFunction(() => window.motionProbe.found.length > 1, undefined, { timeout: 800 }).catch(() => {})
    else await frames()
    const { found, clicks, snapshots } = await stopProbe()
    const enter = found.find(m => m.id === 'chat-session-enter'), exit = found.find(m => m.id === 'chat-session-exit')
    const trusted = clicks.length === 1 && clicks[0].trusted && clicks[0].target === control
    const moved = !!enter && !!exit && eased(enter, 1) && eased(exit, -1) && enter.connected && !enter.snapshot && enter.surface === surface && exit.connected && exit.snapshot && !exit.keyed && exit.parent === 'bots-view' && exit.box === clicks[0].box && snapshots === 1
    evidence.push({ label, preference, clicks, measurements: found, snapshots, pass: trusted && (preference === 'reduce' || !surface ? !found.length && !snapshots : moved) })
    await settle()
  }
  for (const preference of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: preference })
    await measure(menu, 'entry', preference, () => click(create))
    expect(await page.evaluate(() => document.activeElement === window.motionNew)).toBe(true)
    await measure(menu, 'exit', preference, () => page.keyboard.press('Escape'), 'opacity', true)
    await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await menuClosed()
    await click(create)
    await settle()
    await page.getByTestId('topbar').click({ position: { x: 5, y: 5 } })
    await menuClosed()
    await click(create)
    await measure(form, 'entry', preference, () => click(folder))
    await expect(page.locator(input)).toBeFocused()
    await measure(form, 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await click(create); await click(folder)
    await page.locator(input).fill(`Measured folder ${preference}`)
    await measure(form, 'exit', preference, () => page.keyboard.press('Enter'))
    const count = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.filter(f => f.name === name).length, `Measured folder ${preference}`)
    expect(count).toBe(1)
    await click(create); await click(folder)
    await page.locator(input).fill('Cancelled folder')
    await page.keyboard.press('Escape')
    await click(create); await click(folder)
    await settle()
    await expect(page.locator(input)).toBeFocused()
    await page.locator(input).fill(' ')
    await page.keyboard.press('Enter')
    await settle()
    await expect(page.locator(input)).toHaveCount(0)
    record('escape-outside-focus-single-submit-reopen', { preference })

    const search = page.getByRole('textbox', { name: 'Search conversations' })
    const item = `li:has(${row(bot.id)})`
    await measure(item, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(item, 'entry', preference, () => search.fill(''))
    const folderId = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.find(f => f.name === name).id, `Measured folder ${preference}`)
    const folderRow = `[data-testid="sidebar-folder-${folderId}"]`
    await measure(folderRow, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(folderRow, 'entry', preference, () => search.fill(''))

    await mouse(row(bot.id)); await shown(bot)
    await session('thread-to-thread', preference, row(b.id), `bot-${b.id}`, 'bots-thread'); await shown(b)
    await mouse(create); await expect(page.locator(menu)).toBeVisible()
    await session('thread-to-new-chat', preference, fresh, 'bots-new', 'comet-welcome'); await welcome()
    await usable('[data-testid="comet-welcome"]')
    await session('new-chat-to-thread', preference, row(bot.id), `bot-${bot.id}`, 'bots-thread'); await shown(bot)
    await usable('.bots-chat')
    await menuClosed()

    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await measure('.delete-conversation-dialog', 'entry', preference, () => page.getByRole('button', { name: 'Delete', exact: true }).click())
    await page.mouse.click(5, 5)
    await expect(page.locator('.delete-conversation-dialog')).toBeVisible()
    await measure('.delete-conversation-dialog', 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.locator(row(bot.id))).toBeVisible()
    record('delete-backdrop-blocks-escape-closes', { preference })
    await page.evaluate(({ id, folder }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } }), { id: bot.id, folder: folderId })
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible()
    const disclosure = `#folder-${folderId}`, toggle = `[aria-controls="folder-${folderId}"]`
    await measure(disclosure, 'exit', preference, () => click(toggle), 'grid-template-rows', true)
    await expect(page.locator(disclosure)).toHaveAttribute('aria-hidden', 'true')
    await measure(disclosure, 'entry', preference, () => click(toggle), 'grid-template-rows', true)
    await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true')
    expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
    if (preference === 'no-preference') {
      await page.locator(row(bot.id)).focus()
      for (let index = 0; index < 9; index++) { await click(toggle); await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', String(index % 2 === 1)) }
      await settle()
      expect(await page.locator(disclosure).evaluate(node => node.getAttribute('aria-hidden') === 'true' && node.firstElementChild.inert && getComputedStyle(node).visibility === 'hidden' && !node.contains(document.activeElement))).toBe(true)
      await click(toggle)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true', { timeout: 150 })
      expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      record('disclosure-nine-toggles-focus-outside-then-preference-flip')
    }
    await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: null } }), bot.id)
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible()
    await page.evaluate(() => { window.motionNew = document.querySelector('[data-testid="bots-new"]') })
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(({ ipcMain }) => {
    if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('IPC fault injection requires the Electron handler map')
    globalThis.motionFault = { originals: new Map(), calls: 0, mode: '', release: null }
    for (const channel of ['sidebar:change', 'bots:delete']) {
      const original = ipcMain._invokeHandlers.get(channel)
      globalThis.motionFault.originals.set(channel, original)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const fault = globalThis.motionFault
        fault.calls++
        const mode = fault.mode; fault.mode = ''
        if (mode === 'reject') throw new Error('Motion fixture rejected mutation')
        if (mode === 'hold') await new Promise(resolve => { fault.release = resolve })
        return original(event, ...args)
      })
    }
  })
  const calls = () => app.evaluate(() => globalThis.motionFault.calls)
  const fault = mode => app.evaluate((_electron, mode) => { globalThis.motionFault.mode = mode; globalThis.motionFault.calls = 0 }, mode)
  try {
    await fault('reject')
    await click(create); await click(folder)
    await page.locator(input).fill('Rejected folder'); await page.keyboard.press('Enter')
    await expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', 'false')
    expect(await calls()).toBe(1)
    expect(await page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.folders.some(f => f.name === 'Rejected folder'))).toBe(false)
    await fault('hold')
    await click(create); await click(folder)
    await page.locator(input).fill('Pending folder'); await page.keyboard.press('Enter')
    await expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', 'true')
    await click(create); await click(folder)
    await page.locator(input).fill('Fresh session')
    await app.evaluate(() => { globalThis.motionFault.release() })
    await expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator(input)).toHaveValue('Fresh session')
    await expect(page.locator(input)).toBeFocused()
    await page.keyboard.press('Escape')
    await fault('')
    await click(create); await click(folder)
    await expect(page.locator(input)).toBeFocused()
    await page.keyboard.insertText(`<i>🙂 Limit</i> ${'x'.repeat(5000)}`)
    const typed = await page.locator(input).inputValue()
    await page.locator(input).evaluate(node => {
      for (let index = 0; index < 3; index++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      node.blur()
    })
    await expect(page.locator('.sidebar-folder-head span', { hasText: '<i>🙂 Limit</i>' })).toHaveCount(1)
    await expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', 'false')
    record('triple-enter-blur-one-mutation-80-character-literal-text', { length: typed.length, calls: await calls(), pass: typed.length <= 80 && typed.length > 60 && await calls() === 1 && await page.locator('.sidebar-folder-head i').count() === 0 })
    await fault('reject')
    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await expect(page.locator('.delete-conversation-dialog [role="alert"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0)
    await expect(page.locator(row(bot.id))).toBeVisible()
    await fault('hold')
    await click(`[data-testid="sidebar-chat-menu-${d.id}"]`)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await click('.delete-conversation-dialog .danger')
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
    await expect(page.locator('.delete-conversation-dialog')).toBeVisible()
    expect(await calls()).toBe(1)
    await app.evaluate(() => { globalThis.motionFault.release() })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0)
    await expect(page.locator(row(d.id))).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    record('mutation-rejection-pending-session-held-delete-recovery')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.motionFault.release?.()
      for (const [channel, original] of globalThis.motionFault.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.motionFault
    })
  }

  await mouse(row(bot.id)); await shown(bot)
  await session('same-row-click-discards-capture', 'no-preference', row(bot.id), `bot-${bot.id}`, null); await shown(bot)
  await openActivity(page, 'sky')
  await session('non-bots-activity-skips-motion', 'no-preference', row(b.id), `bot-${b.id}`, null); await shown(b)
  for (const mode of ['absent', 'throwing']) {
    const target = mode === 'absent' ? bot : b
    await page.evaluate(mode => { window.motionAnimate = Element.prototype.animate; Element.prototype.animate = mode === 'absent' ? undefined : () => { throw new Error('Motion fixture animate failure') } }, mode)
    try { await session(`element-animate-${mode}-navigation-completes`, 'no-preference', row(target.id), `bot-${target.id}`, null) }
    finally { await page.evaluate(() => { Element.prototype.animate = window.motionAnimate }) }
    await shown(target); await usable('.bots-chat')
    expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  }

  const during = []
  for (const delay of [0, 60, 120, 180, 240]) for (const second of [row(bot.id), create]) {
    await mouse(row(bot.id)); await shown(bot); await settle()
    const first = await center(row(b.id)), next = await center(second)
    await startProbe(null)
    await page.mouse.click(...first)
    if (delay) await page.waitForTimeout(delay)
    await page.mouse.click(...next)
    const { clicks, snapshots } = await stopProbe()
    const elapsed = clicks[1]?.at - clicks[0]?.at, targets = clicks.map(one => one.target), midMotion = clicks[1]?.snapshots === 1
    if (second === create) { await expect(page.locator(menu)).toBeVisible(); await expect(page.locator(fresh)).toBeFocused(); await shown(b); await page.keyboard.press('Escape'); await menuClosed() }
    else await shown(bot)
    during.push(midMotion)
    evidence.push({ label: 'timed-trusted-double-click', delay, elapsed, targets, midMotion, snapshots, pass: clicks.length === 2 && clicks.every(one => one.trusted) && targets[0] === `bot-${b.id}` && targets[1] === (second === create ? 'sidebar-create' : `bot-${bot.id}`) && elapsed >= delay && (elapsed > 120 || midMotion) && snapshots <= 1 })
  }
  record('second-click-landed-while-exit-snapshot-present', { pass: during.slice(0, 2).every(Boolean) })

  await settle()
  const storm = await page.evaluate(({ rows }) => {
    const press = id => { document.querySelector(`[data-testid="bot-${id}"]`).click(); return document.querySelector(`[data-testid="bot-${id}"]`).classList.contains('active') && document.querySelectorAll('.bots-row.active').length === 1 }
    const count = () => document.querySelectorAll('[data-chat-snapshot]').length + document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).length
    const pair = press(rows[1]) && press(rows[0])
    let handled = 0, most = 0
    for (let index = 0; index < 60; index++) { handled += Number(press(rows[(index + 1) % 3])); most = Math.max(most, count()) }
    return { pair, handled, most }
  }, { rows: [bot.id, b.id, c.id] })
  await shown(bot)
  await page.waitForTimeout(300)
  await shown(bot); await usable('.bots-chat')
  record('synthetic-pair-and-sixty-click-storm-each-handled-in-order', { ...storm, residue: await residue(), pass: storm.pair && storm.handled === 60 && storm.most <= 3 && (await residue()).snapshots === 0 && (await residue()).owned === 0 })

  let flip
  for (let attempt = 0; attempt < 3 && !(flip?.elapsed < 150); attempt++) {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await mouse(row(bot.id)); await shown(bot); await settle()
    await startProbe(null)
    await mouse(row(c.id))
    const started = await residue()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const cleared = await (await page.waitForFunction(() => !document.querySelector('[data-chat-snapshot]') && !document.getAnimations().some(animation => animation.id.startsWith('chat-session-')) && performance.now())).jsonValue()
    flip = { elapsed: cleared - (await stopProbe()).clicks[0].at, started }
  }
  await shown(c); await usable('.bots-chat')
  record('reduce-preference-mid-session-cancels-before-natural-end', { ...flip, pass: flip.elapsed < 150 && flip.started.snapshots === 1 && flip.started.owned === 2 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator(menu)).toBeHidden({ timeout: 120 })
  await menuClosed()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await click(create); await click(folder)
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await frames()
  await expect(page.locator(form)).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  record('reduce-preference-mid-menu-and-form-exit')

  for (let index = 0; index < 21; index++) await mouse(create)
  await expect(page.locator(menu)).toBeVisible()
  expect(await page.locator(menu).evaluate(node => !node.inert && node.getAttribute('aria-hidden') === 'false' && document.querySelector('[data-testid="bots-new"]') === window.motionNew)).toBe(true)
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
  await menuClosed()
  await mouse(create); await mouse(create); await menuClosed()
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await mouse(row(b.id)); await shown(b); await menuClosed()
  record('twenty-one-toggles-tab-and-outside-click-keep-destination-action')

  const widths = []
  for (const width of [620, 400, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(Math.min(800, width), 560); win.setSize(width, 900) }, width)
    await page.waitForFunction(width => Math.abs(innerWidth - width) < 40, width)
    if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
    await settle(); await mouse(create); await expect(page.locator(menu)).toBeVisible(); await settle()
    widths.push(await page.locator(menu).evaluate(node => { const box = node.getBoundingClientRect(); return { innerWidth, left: box.left, right: box.right, bottom: box.bottom, inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight } }))
    await page.keyboard.press('Escape'); await menuClosed()
    if (width === 620) { await mouse(row(bot.id)); await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true'); await shown(bot) }
  }
  record('create-menu-inside-viewport-and-narrow-navigation-toggles-sidebar-once', { widths, pass: widths.every(one => one.inside) })

  await click(`[data-testid="sidebar-chat-menu-${e.id}"]`)
  await expect(page.locator('.sidebar-organize-menu')).toBeVisible()
  await page.evaluate(id => window.engram.botDelete(id), e.id)
  await expect(page.locator('.sidebar-organize-menu')).toHaveCount(0)
  await expect(page.locator(row(e.id))).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Search conversations' })
  for (let index = 0; index < 16; index++) await search.fill(index % 2 ? '' : 'No matching fixture')
  await settle()
  expect(await page.evaluate(ids => ids.every(id => document.querySelectorAll(`[data-testid="bot-${id}"]`).length === 1) && !document.querySelector('[data-motion-row][aria-hidden="true"]'), [bot.id, b.id, c.id])).toBe(true)
  record('open-menu-row-removed-and-sixteen-search-reversals-leave-no-ghosts')
  const total = await page.evaluate(async () => { for (let index = 0; index < 300; index++) await window.engram.botCreate({ name: `Bulk ${index}` }); return (await window.engram.botsList()).length })
  await expect(page.locator('[data-testid="sidebar-chats"] .bots-row')).toHaveCount(total, { timeout: 10_000 })
  await search.fill('Bulk 29')
  await expect(page.locator('[data-testid="sidebar-chats"] li[data-motion-state="live"]')).toHaveCount(11)
  await search.fill('')
  await settle()
  await expect(page.locator('[data-testid="sidebar-chats"] li')).toHaveCount(total)
  record('three-hundred-row-filter-round-trip', { total })

  await openActivity(page, 'routines')
  await expect(page.locator(fresh)).toHaveCount(0)
  await openActivity(page, 'bots')
  await expect(page.locator(fresh)).toHaveCount(1)
  record('routine-mode-keeps-new-chat-absent')
  await mouse(row(bot.id)); await shown(bot); await settle()
  for (const open of ['form', 'menu', 'session']) {
    if (open === 'session') await mouse(row(b.id))
    else { await click(create); if (open === 'form') { await click(folder); await page.locator(input).fill('Unsaved reload') } }
    await page.reload()
    await expect(page.locator(row(bot.id))).toBeVisible()
    await page.evaluate(() => { window.motionNew = document.querySelector('[data-testid="bots-new"]') })
    await menuClosed()
    await expect(page.locator(`${form}, [data-chat-snapshot]`)).toHaveCount(0)
  }
  expect(await page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.folders.some(f => f.name === 'Unsaved reload'))).toBe(false)
  for (let index = 0; index < 2; index++) { await openActivity(page, 'sky'); await openActivity(page, 'bots') }
  await mouse(row(c.id)); await shown(c); await usable('.bots-chat')
  await settle()
  expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  record('reload-with-open-form-menu-and-session-exit-then-activity-round-trips', { errors })
  return { ok: evidence.every(record => record.pass) && !errors.length, evidence }
  } catch (error) { return { ok: false, evidence: [...evidence, { error: error.stack }] } }
}
