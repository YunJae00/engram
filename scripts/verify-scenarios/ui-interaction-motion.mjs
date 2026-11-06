/* global window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, Element, Node, KeyboardEvent, innerWidth, innerHeight */
import { appendBotTurn, createBot } from '../../packages/core/src/index.ts'

const LIVE = '.bots-view :is(.bots-thread, .comet-welcome):not([data-chat-snapshot])'
export async function run(page, { expect, openActivity, app, paths }) {
  const evidence = [], errors = []
  try {
  page.on('pageerror', error => errors.push(error.message))
  // An unmapped window gets no compositor frames on X11; natural motion timing needs real frames.
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 900); win.showInactive() })
  const long = []
  for (const letter of ['A', 'B']) {
    const made = await createBot(paths, { name: `Motion long ${letter}` })
    for (let index = 1; index <= 40; index++) await appendBotTurn(paths, made.id, { role: index % 2 ? 'user' : 'assistant', text: `Long ${letter} turn ${index}${index === 40 ? ' terminal' : ''}\n${'History keeps the newest turn at the foot of the thread.\n'.repeat(2)}`, at: new Date(Date.now() - (41 - index) * 60_000).toISOString() })
    long.push({ ...made, last: `Long ${letter} turn 40 terminal` })
  }
  const [longA, longB] = long
  await page.reload(); await openActivity(page, 'bots')
  const names = ['Motion alpha', 'Motion beta', 'Motion gamma', 'Motion delta', 'Motion epsilon']
  const [bot, b, c, d, e] = await page.evaluate(async names => { const made = []; for (const name of names) made.push(await window.engram.botCreate({ name })); return made }, names)
  const row = id => `[data-testid="bot-${id}"]`
  await expect(page.locator(row(e.id))).toBeVisible()
  const create = '[data-testid="sidebar-create"]', fresh = '[data-testid="bots-new"]', folder = '[aria-label="New chat folder"]'
  const form = '.sidebar-folder-create', menu = '.sidebar-create-menu', input = '[aria-label="Folder name"]', dialog = '.delete-conversation-dialog'
  const collection = page.getByTestId('sidebar-chat-collection'), field = page.locator(input)
  const record = (label, detail = {}) => evidence.push({ label, ...detail, pass: detail.pass ?? true })
  const click = selector => page.evaluate(selector => document.querySelector(selector).click(), selector)
  const center = async selector => { const box = await page.locator(selector).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }
  const mouse = async selector => page.mouse.click(...await center(selector))
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot], [data-motion-state="exit"]:not(.sidebar-create-menu)') && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity), undefined, { timeout: 2000 })
  const shown = async one => { await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator('[data-testid="bots-thread"] .bots-hint')).toContainText(one.name) }
  // A populated thread has arrived once its row is active, its terminal turn is live exactly once, it overflows and auto-follow rests at the foot.
  const foot = one => page.evaluate(([selector, text]) => { const thread = document.querySelector(selector); return { overflow: thread.scrollHeight > thread.clientHeight, foot: Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) <= 2, unique: [...document.querySelectorAll(`${selector} .bubble-msg`)].filter(node => node.textContent.includes(text)).length } }, [LIVE, one.last])
  const arrived = async one => { await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator(LIVE)).toContainText(one.last); await expect.poll(() => foot(one)).toEqual({ overflow: true, foot: true, unique: 1 }) }
  const visit = async one => { await mouse(row(one.id)); await (one.last ? arrived(one) : shown(one)); await settle() }
  const welcome = async () => { await expect(page.getByTestId('comet-welcome')).toBeVisible(); await expect(page.locator('.bots-row.active')).toHaveCount(0) }
  const usable = async scope => { const box = page.locator(`${scope} textarea`); await box.fill('Ready after navigation'); await expect(box).toHaveValue('Ready after navigation'); await box.fill('') }
  const residue = () => page.evaluate(() => ({ snapshots: document.querySelectorAll('[data-chat-snapshot]').length, owned: document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).length }))
  const clean = async () => expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  const openForm = async () => { await click(create); await click(folder) }
  const folders = name => page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.filter(f => f.name === name).length, name)
  const menuClosed = async () => { await expect(page.locator(menu)).toBeHidden(); expect(await page.locator(menu).evaluate(node => node.inert && node.getAttribute('aria-hidden') === 'true' && !node.contains(document.activeElement) && document.querySelectorAll('[data-testid="bots-new"]').length === 1 && document.querySelector('[data-testid="bots-new"]') === window.motionNew && !window.motionNew.disabled)).toBe(true) }
  const remember = () => page.evaluate(() => { window.motionNew = document.querySelector('[data-testid="bots-new"]') })
  await remember(); await menuClosed()
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
        const samples = [0, .25, .75, 1].map(fraction => { animation.currentTime = Number(timing.duration) * fraction; const style = getComputedStyle(node); return property === 'grid-template-rows' ? parseFloat(style.height) : Number(style.opacity) })
        animation.currentTime = 0
        probe.found.push({ animation, box: box(node), id: animation.id, duration: timing.duration, easing: timing.easing === 'linear' ? effect.getKeyframes()[0]?.easing : timing.easing, samples, connected: node.isConnected, snapshot: node.matches('[data-chat-snapshot]'), keyed: !!node.closest('.bots-chat'), parent: node.parentElement?.className, surface: node.dataset.testid ?? '' })
        animation.play()
      }
      probe.frame = requestAnimationFrame(scan)
    }
    scan()
  }, { target, property })
  const stopProbe = () => page.evaluate(() => {
    const probe = window.motionProbe; probe.stopped = true; cancelAnimationFrame(probe.frame); document.removeEventListener('click', probe.click, true)
    return { found: probe.found.map(record => ({ ...record, animation: undefined })), clicks: probe.clicks, snapshots: probe.snapshots }
  })
  // The passive observer only reads: it never pauses, seeks, finishes or restarts an animation.
  const watch = () => page.evaluate(selector => {
    const w = window.motionWatch = { frames: [], scrolls: [], clicks: [], resizes: [], stopped: false }
    const box = node => { const rect = node?.getBoundingClientRect(); return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join() : '' }, nested = node => node ? [...node.querySelectorAll('*')].map(child => child.scrollTop).filter(Boolean).join() : ''
    // The exit keyframes translate the snapshot, so its box is read from layout offsets rather than the transformed client rect.
    const placed = node => { const parent = node?.offsetParent, rect = parent?.getBoundingClientRect(); return rect ? [rect.left + parent.clientLeft + node.offsetLeft, rect.top + parent.clientTop + node.offsetTop, node.offsetWidth, node.offsetHeight].map(Math.round).join() : '' }
    const name = node => node === document ? 'document' : node.closest('[data-chat-snapshot]') ? 'snapshot' : node.dataset.testid ?? node.className, paint = node => node ? { opacity: Number(getComputedStyle(node).opacity), transform: getComputedStyle(node).transform, connected: node.isConnected } : null
    w.scroll = event => w.scrolls.push({ at: performance.now(), target: name(event.target), top: event.target.scrollTop ?? null }); w.resize = () => w.resizes.push(performance.now())
    w.click = event => { const live = document.querySelector(selector); w.clicks.push({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, box: box(live), top: live?.scrollTop ?? 0, nested: nested(live) }) }
    document.addEventListener('scroll', w.scroll, true); document.addEventListener('click', w.click, true); window.addEventListener('resize', w.resize)
    const tick = () => {
      if (w.stopped) return
      const live = document.querySelector(selector), snapshot = document.querySelector('[data-chat-snapshot]')
      w.frames.push({ at: performance.now(), owned: document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime, connected: animation.effect.target.isConnected })), live: paint(live), snapshot: paint(snapshot), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, scroll: live ? [live.scrollTop, live.clientHeight, live.scrollHeight] : null, snapshotTop: snapshot?.scrollTop ?? null, snapshotNested: nested(snapshot), snapshotBox: placed(snapshot), snapshotClean: !snapshot || (!snapshot.querySelector('[data-testid]') && !snapshot.contains(document.activeElement)) })
      w.frame = requestAnimationFrame(tick)
    }
    tick()
  }, LIVE)
  const unwatch = () => page.evaluate(() => {
    const w = window.motionWatch; w.stopped = true; cancelAnimationFrame(w.frame); document.removeEventListener('scroll', w.scroll, true); document.removeEventListener('click', w.click, true); window.removeEventListener('resize', w.resize)
    return { frames: w.frames, scrolls: w.scrolls, clicks: w.clicks, resizes: w.resizes }
  })
  const quiet = () => page.waitForFunction(() => window.motionWatch.frames.some(frame => frame.owned.length) && !document.querySelector('[data-chat-snapshot]') && !document.getAnimations().some(animation => animation.id.startsWith('chat-session-')), undefined, { timeout: 1500 }).catch(() => {})
  const cleared = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot]') && !document.getAnimations().some(animation => animation.id.startsWith('chat-session-')) && performance.now(), undefined, { timeout: 1500 })
  const time = frame => Math.min(...frame.owned.map(animation => animation.time))
  const summarize = ({ frames, scrolls, clicks }) => {
    const t0 = clicks[0]?.at ?? 0, outgoing = clicks[0] ?? {}
    const during = frames.filter(frame => frame.at > t0 && frame.owned.length === 2 && frame.owned.every(animation => animation.state === 'running' && animation.connected) && frame.snapshot?.connected && frame.live && frame.snapshots === 1)
    const end = frames.find(frame => during.length && frame.at > during.at(-1).at && !frame.owned.length && !frame.snapshots)
    const mount = scrolls.find(scroll => scroll.at > t0 && scroll.target === 'bots-thread'), after = mount ? during.filter(frame => frame.at > mount.at) : []
    const opposite = after.some((frame, index) => index > 0 && frame.live.opacity > after[index - 1].live.opacity && frame.snapshot.opacity < after[index - 1].snapshot.opacity)
    const exact = frame => frame.snapshotBox === outgoing.box && Math.abs(frame.snapshotTop - outgoing.top) <= 2 && frame.snapshotNested === outgoing.nested && frame.snapshotClean
    const faithful = during.every(exact), drift = during.find(frame => !exact(frame))
    const ran = clicks.length === 1 && clicks[0].trusted && during.length >= 2 && during.some(frame => time(frame) >= 120) && faithful && !!end && end.at - t0 <= 300
    return { ran, postScroll: !!mount && after.length >= 2 && opposite && after.some(frame => time(frame) >= 80), clicks, samples: during.length, mountScrollAt: mount ? Math.round(mount.at - t0) : null, postScrollSamples: after.length, opposite, endedAt: end ? Math.round(end.at - t0) : null, faithful, drift: drift && { box: drift.snapshotBox, top: drift.snapshotTop, nested: drift.snapshotNested, clean: drift.snapshotClean }, scrolls: scrolls.map(scroll => ({ ...scroll, at: Math.round(scroll.at - t0) })), opacities: during.map(frame => [Math.round(time(frame)), frame.live.opacity.toFixed(2), frame.snapshot.opacity.toFixed(2)]) }
  }
  // One trusted click into a populated or welcome surface under natural motion; a cached destination must keep both animations alive past its mount scroll.
  async function natural(label, selector, check, cached) {
    await settle(); await watch(); await mouse(selector); await quiet(); await frames()
    const summary = summarize(await unwatch())
    await check(); evidence.push({ label, cached, ...summary, pass: summary.ran && (!cached || summary.postScroll) }); await settle()
  }
  const eased = (m, sign) => {
    const [start, quarter, later, end] = m.samples, range = end - start
    return m.duration >= 120 && m.duration <= 260 && m.easing !== 'linear' && Math.abs(range) > .5 && Math.sign(range) === sign && Math.abs((quarter - start) / range - .25) > .05 && quarter !== later
  }
  async function measure(target, direction, preference, action, property = 'opacity', persistent = false) {
    await settle(); await startProbe(target, property); await action(); await frames()
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
    await settle(); await startProbe(null); await mouse(selector)
    if (preference === 'no-preference' && surface) await page.waitForFunction(() => window.motionProbe.found.length > 1, undefined, { timeout: 800 }).catch(() => {})
    else await frames()
    const { found, clicks, snapshots } = await stopProbe()
    const enter = found.find(m => m.id === 'chat-session-enter'), exit = found.find(m => m.id === 'chat-session-exit')
    const trusted = clicks.length === 1 && clicks[0].trusted && clicks[0].target === control
    const moved = !!enter && !!exit && eased(enter, 1) && eased(exit, -1) && enter.connected && !enter.snapshot && enter.surface === surface && exit.connected && exit.snapshot && !exit.keyed && exit.parent === 'bots-view' && exit.box === clicks[0].box && snapshots === 1
    evidence.push({ label, preference, clicks, measurements: found, snapshots, pass: trusted && (preference === 'reduce' || !surface ? !found.length && !snapshots : moved) })
    await settle()
  }
  const search = page.getByRole('textbox', { name: 'Search conversations' })
  for (const preference of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: preference })
    await measure(menu, 'entry', preference, () => click(create)); expect(await page.evaluate(() => document.activeElement === window.motionNew)).toBe(true)
    await measure(menu, 'exit', preference, () => page.keyboard.press('Escape'), 'opacity', true); await expect(page.getByTestId('sidebar-create')).toBeFocused(); await menuClosed()
    await click(create); await settle(); await page.getByTestId('topbar').click({ position: { x: 5, y: 5 } }); await menuClosed()
    await click(create); await measure(form, 'entry', preference, () => click(folder)); await expect(field).toBeFocused()
    await measure(form, 'exit', preference, () => page.keyboard.press('Escape')); await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await openForm(); await field.fill(`Measured folder ${preference}`)
    await measure(form, 'exit', preference, () => page.keyboard.press('Enter')); expect(await folders(`Measured folder ${preference}`)).toBe(1)
    await openForm(); await field.fill('Cancelled folder'); await page.keyboard.press('Escape')
    await openForm(); await settle(); await expect(field).toBeFocused()
    await field.fill(' '); await page.keyboard.press('Enter'); await settle(); await expect(field).toHaveCount(0)
    record('escape-outside-focus-single-submit-reopen', { preference })
    const item = `li:has(${row(bot.id)})`
    await measure(item, 'exit', preference, () => search.fill('No matching fixture')); await measure(item, 'entry', preference, () => search.fill(''))
    const folderId = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.find(f => f.name === name).id, `Measured folder ${preference}`)
    const folderRow = `[data-testid="sidebar-folder-${folderId}"]`
    await measure(folderRow, 'exit', preference, () => search.fill('No matching fixture')); await measure(folderRow, 'entry', preference, () => search.fill(''))
    await visit(bot)
    await session('thread-to-thread', preference, row(b.id), `bot-${b.id}`, 'bots-thread'); await shown(b)
    await mouse(create); await expect(page.locator(menu)).toBeVisible()
    await session('thread-to-new-chat', preference, fresh, 'bots-new', 'comet-welcome'); await welcome(); await usable('[data-testid="comet-welcome"]')
    await session('new-chat-to-thread', preference, row(bot.id), `bot-${bot.id}`, 'bots-thread'); await shown(bot); await usable('.bots-chat'); await menuClosed()
    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await measure(dialog, 'entry', preference, () => page.getByRole('button', { name: 'Delete', exact: true }).click())
    await page.mouse.click(5, 5); await expect(page.locator(dialog)).toBeVisible()
    await measure(dialog, 'exit', preference, () => page.keyboard.press('Escape')); await expect(page.locator(row(bot.id))).toBeVisible()
    record('delete-backdrop-blocks-escape-closes', { preference })
    await page.evaluate(({ id, folder }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } }), { id: bot.id, folder: folderId })
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible()
    const disclosure = `#folder-${folderId}`, toggle = `[aria-controls="folder-${folderId}"]`
    await measure(disclosure, 'exit', preference, () => click(toggle), 'grid-template-rows', true); await expect(page.locator(disclosure)).toHaveAttribute('aria-hidden', 'true')
    await measure(disclosure, 'entry', preference, () => click(toggle), 'grid-template-rows', true); await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true')
    expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
    if (preference === 'no-preference') {
      await page.locator(row(bot.id)).focus()
      for (let index = 0; index < 9; index++) { await click(toggle); await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', String(index % 2 === 1)) }
      await settle()
      expect(await page.locator(disclosure).evaluate(node => node.getAttribute('aria-hidden') === 'true' && node.firstElementChild.inert && getComputedStyle(node).visibility === 'hidden' && !node.contains(document.activeElement))).toBe(true)
      await click(toggle); await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true', { timeout: 150 })
      expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' }); record('disclosure-nine-toggles-focus-outside-then-preference-flip')
    }
    await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: null } }), bot.id)
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await remember()
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(({ ipcMain }) => {
    if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('IPC fault injection requires the Electron handler map')
    const fault = globalThis.motionFault = { originals: new Map(), calls: 0, modes: [], releases: [] }
    for (const channel of ['sidebar:change', 'bots:delete']) {
      const original = ipcMain._invokeHandlers.get(channel)
      fault.originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        fault.calls++
        const planned = fault.modes.shift() ?? '', mode = planned === 'hold' ? await new Promise(resolve => { fault.releases.push(resolve) }) : planned
        if (mode === 'reject') throw new Error('Motion fixture rejected mutation')
        return original(event, ...args)
      })
    }
  })
  const calls = () => app.evaluate(() => globalThis.motionFault.calls)
  const fault = (...modes) => app.evaluate((_electron, modes) => { Object.assign(globalThis.motionFault, { modes, calls: 0, releases: [] }) }, modes)
  const held = count => expect.poll(() => app.evaluate(() => globalThis.motionFault.releases.length)).toBe(count)
  const release = (index, outcome = '') => app.evaluate((_electron, [index, outcome]) => { globalThis.motionFault.releases[index](outcome) }, [index, outcome])
  const submit = async name => { await openForm(); await field.fill(name); await page.keyboard.press('Enter') }
  const busy = state => expect(collection).toHaveAttribute('aria-busy', state)
  const newerForm = async name => { await busy('false'); await expect(field).toHaveValue(name); await expect(field).toBeFocused(); await page.keyboard.press('Escape') }
  try {
    await fault('reject'); await submit('Rejected folder'); await busy('false')
    expect(await calls()).toBe(1); expect(await folders('Rejected folder')).toBe(0)
    await fault('hold'); await submit('Pending folder'); await busy('true')
    await openForm(); await field.fill('Fresh session'); await held(1); await release(0); await newerForm('Fresh session')
    await fault('hold', 'hold'); await submit('Concurrent one'); await submit('Concurrent two'); await held(2)
    await openForm(); await field.fill('Third form'); await release(1)
    await expect(page.locator('.sidebar-folder-head span', { hasText: 'Concurrent two' })).toHaveCount(1); await busy('true')
    await release(0)
    record('reverse-order-concurrent-folder-sessions-persist-once-newer-form-untouched', { calls: await calls(), one: await folders('Concurrent one'), two: await folders('Concurrent two'), pass: await calls() === 2 && await folders('Concurrent one') === 1 && await folders('Concurrent two') === 1 })
    await newerForm('Third form')
    await fault('hold'); await submit('Stale rejected'); await held(1)
    await openForm(); await field.fill('Newer form'); await release(0, 'reject')
    await expect(page.locator('.toast')).toContainText('Motion fixture rejected mutation')
    record('stale-rejection-reports-error-and-leaves-newer-form', { pass: await folders('Stale rejected') === 0 })
    await newerForm('Newer form')
    await fault(); await openForm(); await expect(field).toBeFocused()
    await page.keyboard.insertText(`<i>🙂 Limit</i> ${'x'.repeat(5000)}`)
    const typed = await field.inputValue()
    await field.evaluate(node => { for (let index = 0; index < 3; index++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); node.blur() })
    await expect(page.locator('.sidebar-folder-head span', { hasText: '<i>🙂 Limit</i>' })).toHaveCount(1); await busy('false')
    record('triple-enter-blur-one-mutation-80-character-literal-text', { length: typed.length, calls: await calls(), pass: typed.length <= 80 && typed.length > 60 && await calls() === 1 && await page.locator('.sidebar-folder-head i').count() === 0 })
    const confirmDelete = async id => { await click(`[data-testid="sidebar-chat-menu-${id}"]`); await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click() }
    await fault('reject'); await confirmDelete(bot.id)
    await expect(page.locator(`${dialog} [role="alert"]`)).toBeVisible(); await page.keyboard.press('Escape')
    await expect(page.locator(dialog)).toHaveCount(0); await expect(page.locator(row(bot.id))).toBeVisible()
    await fault('hold'); await confirmDelete(d.id)
    await click(`${dialog} .danger`); await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
    await expect(page.locator(dialog)).toBeVisible(); expect(await calls()).toBe(1)
    await held(1); await release(0); await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator(dialog)).toHaveCount(0); await expect(page.locator(row(d.id))).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    record('mutation-rejection-pending-session-held-delete-recovery')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      for (const resolve of globalThis.motionFault.releases) resolve('')
      for (const [channel, original] of globalThis.motionFault.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.motionFault
    })
  }

  await visit(bot)
  await natural('empty-to-long-A-first-visit', row(longA.id), () => arrived(longA), false)
  await natural('long-A-to-long-B-first-visit', row(longB.id), () => arrived(longB), false)
  await natural('long-B-to-long-A-revisit', row(longA.id), () => arrived(longA), true)
  await visit(bot)
  await natural('empty-to-long-A-revisit', row(longA.id), () => arrived(longA), true)
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await natural('long-A-to-new-chat', fresh, welcome, false); await usable('[data-testid="comet-welcome"]')
  await natural('new-chat-to-long-B-revisit', row(longB.id), () => arrived(longB), true); await usable('.bots-chat'); await menuClosed()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await session('populated-reduced-motion-navigates-without-pair', 'reduce', row(longA.id), `bot-${longA.id}`, 'bots-thread'); await arrived(longA); await page.emulateMedia({ reducedMotion: 'no-preference' })

  await visit(longA)
  const thread = await center(LIVE)
  await watch(); await mouse(row(longB.id)); await page.mouse.move(...thread); await page.mouse.wheel(0, -600); await quiet(); await frames()
  const wheel = await unwatch(), wheelStart = wheel.clicks[0].at, wheelSummary = summarize(wheel)
  const ups = wheel.scrolls.filter(scroll => scroll.target === 'bots-thread' && scroll.at > wheelStart)
  const up = ups.find((scroll, index) => index > 0 && scroll.top < ups[index - 1].top - 1)
  const survived = up ? wheel.frames.filter(frame => frame.at > up.at && frame.owned.length === 2 && frame.owned.every(animation => animation.state === 'running')).length : 0
  await expect(page.locator(row(longB.id))).toHaveClass(/active/); await expect(page.locator(LIVE)).toContainText(longB.last)
  const scrolledUp = await page.evaluate(selector => { const node = document.querySelector(selector); return node.scrollHeight - node.clientHeight - node.scrollTop > 100 }, LIVE)
  record('wheel-up-during-motion-moves-thread-and-motion-survives', { upAt: up ? Math.round(up.at - wheelStart) : null, survived, scrolledUp, ...wheelSummary, pass: !!up && survived >= 1 && scrolledUp && wheelSummary.ran })

  await visit(longA)
  await watch(); await mouse(row(longB.id))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 860))
  await cleared(); await frames()
  const resized = await unwatch(), resizeStart = resized.clicks[0].at
  const resizeAt = resized.resizes.find(at => at > resizeStart), gone = resized.frames.find(frame => frame.at > resizeStart && !frame.owned.length && !frame.snapshots)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await page.waitForFunction(() => Math.abs(innerWidth - 1280) < 40)
  await arrived(longB); await usable('.bots-chat')
  record('resize-during-motion-disposes-pair-and-destination-usable', { resizeAt: resizeAt ? Math.round(resizeAt - resizeStart) : null, clearedAt: gone ? Math.round(gone.at - resizeStart) : null, residue: await residue(), pass: !!gone && (!resizeAt || gone.at - resizeAt <= 50) && (await residue()).snapshots === 0 })

  await visit(bot)
  await session('same-row-click-discards-capture', 'no-preference', row(bot.id), `bot-${bot.id}`, null); await shown(bot)
  await openActivity(page, 'sky')
  await session('non-bots-activity-skips-motion', 'no-preference', row(b.id), `bot-${b.id}`, null); await shown(b)
  for (const [mode, target] of [['absent', bot], ['throwing', b], ['capture', c]]) {
    await page.evaluate(mode => { window.motionRestore = mode === 'capture' ? [Node.prototype, 'cloneNode', Node.prototype.cloneNode] : [Element.prototype, 'animate', Element.prototype.animate]; window.motionRestore[0][window.motionRestore[1]] = mode === 'absent' ? undefined : () => { throw new Error('Motion fixture failure') } }, mode)
    try { await session(`${mode}-failure-navigation-completes`, 'no-preference', row(target.id), `bot-${target.id}`, null) }
    finally { await page.evaluate(() => { const [owner, key, original] = window.motionRestore; owner[key] = original }) }
    await shown(target); await usable('.bots-chat'); await clean()
  }

  const during = []
  for (const delay of [0, 60, 120, 180, 240]) for (const second of [row(longA.id), create]) {
    await visit(longA)
    const first = await center(row(longB.id)), next = await center(second)
    await watch(); await page.mouse.click(...first)
    if (delay) await page.waitForTimeout(delay)
    await page.mouse.click(...next)
    const { clicks, frames: seen } = await unwatch(), snapshots = Math.max(...seen.map(frame => frame.snapshots))
    const elapsed = clicks[1]?.at - clicks[0]?.at, targets = clicks.map(one => one.target), midMotion = clicks[1]?.snapshots === 1
    if (second === create) { await expect(page.locator(menu)).toBeVisible(); await expect(page.locator(fresh)).toBeFocused(); await arrived(longB); await page.keyboard.press('Escape'); await menuClosed() }
    await settle(); await page.waitForTimeout(300); await arrived(second === create ? longB : longA)
    during.push(midMotion)
    evidence.push({ label: 'timed-trusted-double-click-long-histories', delay, elapsed, targets, midMotion, snapshots, pass: clicks.length === 2 && clicks.every(one => one.trusted) && targets[0] === `bot-${longB.id}` && targets[1] === (second === create ? 'sidebar-create' : `bot-${longA.id}`) && elapsed >= delay && (elapsed > 120 || midMotion) && snapshots <= 1 && (await residue()).snapshots === 0 })
  }
  record('second-click-landed-while-exit-snapshot-present', { pass: during.slice(0, 2).every(Boolean) })
  const order = [longB, c, longA], centers = []
  for (const one of order) centers.push(await center(row(one.id)))
  await watch(); for (const point of centers) await page.mouse.click(...point)
  const sequence = await unwatch(), sequenceSnapshots = Math.max(...sequence.frames.map(frame => frame.snapshots))
  await page.waitForTimeout(300); await settle(); await arrived(longA)
  record('real-B-C-A-sequence-ends-at-A', { targets: sequence.clicks.map(one => one.target), snapshots: sequenceSnapshots, residue: await residue(), pass: sequence.clicks.every(one => one.trusted) && sequence.clicks.map(one => one.target).join() === order.map(one => `bot-${one.id}`).join() && sequenceSnapshots <= 1 && (await residue()).snapshots === 0 })

  await settle()
  const storm = await page.evaluate(({ rows }) => {
    const press = id => { document.querySelector(`[data-testid="bot-${id}"]`).click(); return document.querySelector(`[data-testid="bot-${id}"]`).classList.contains('active') && document.querySelectorAll('.bots-row.active').length === 1 }
    const count = () => document.querySelectorAll('[data-chat-snapshot]').length + document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).length
    const pair = press(rows[1]) && press(rows[0])
    let handled = 0, most = 0
    for (let index = 0; index < 60; index++) { handled += Number(press(rows[(index + 1) % 3])); most = Math.max(most, count()) }
    return { pair, handled, most }
  }, { rows: [bot.id, b.id, c.id] })
  await shown(bot); await page.waitForTimeout(300); await shown(bot); await usable('.bots-chat')
  record('synthetic-pair-and-sixty-click-storm-each-handled-in-order', { ...storm, residue: await residue(), pass: storm.pair && storm.handled === 60 && storm.most <= 3 && (await residue()).snapshots === 0 && (await residue()).owned === 0 })

  await visit(longA)
  await startProbe(null); await mouse(row(longB.id))
  const started = await residue()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const clearedAt = await (await cleared()).jsonValue()
  const flip = { elapsed: clearedAt - (await stopProbe()).clicks[0].at, started }
  await arrived(longB); await usable('.bots-chat')
  record('reduce-preference-mid-populated-session-cancels-before-natural-end', { ...flip, pass: flip.elapsed < 150 && flip.started.snapshots === 1 && flip.started.owned === 2 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mouse(create); await expect(page.locator(menu)).toBeVisible(); await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator(menu)).toBeHidden({ timeout: 120 }); await menuClosed()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openForm(); await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await frames(); await expect(page.locator(form)).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  record('reduce-preference-mid-menu-and-form-exit')

  for (let index = 0; index < 21; index++) await mouse(create)
  await expect(page.locator(menu)).toBeVisible()
  expect(await page.locator(menu).evaluate(node => !node.inert && node.getAttribute('aria-hidden') === 'false' && document.querySelector('[data-testid="bots-new"]') === window.motionNew)).toBe(true)
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await menuClosed()
  await mouse(create); await mouse(create); await menuClosed()
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await mouse(row(b.id)); await shown(b); await menuClosed()
  record('twenty-one-toggles-tab-and-outside-click-keep-destination-action')

  const widths = []
  for (const width of [620, 400, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(Math.min(800, width), 560); win.setSize(width, 900) }, width)
    await page.waitForFunction(width => Math.abs(innerWidth - width) < 40, width); if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
    await settle(); await mouse(create); await expect(page.locator(menu)).toBeVisible(); await settle()
    widths.push(await page.locator(menu).evaluate(node => { const box = node.getBoundingClientRect(); return { innerWidth, left: box.left, right: box.right, bottom: box.bottom, inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight } }))
    await page.keyboard.press('Escape'); await menuClosed()
    if (width === 620) { await mouse(row(bot.id)); await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true'); await shown(bot) }
  }
  record('create-menu-inside-viewport-and-narrow-navigation-toggles-sidebar-once', { widths, pass: widths.every(one => one.inside) })

  await click(`[data-testid="sidebar-chat-menu-${e.id}"]`); await expect(page.locator('.sidebar-organize-menu')).toBeVisible()
  await page.evaluate(id => window.engram.botDelete(id), e.id)
  await expect(page.locator('.sidebar-organize-menu')).toHaveCount(0); await expect(page.locator(row(e.id))).toHaveCount(0)
  for (let index = 0; index < 16; index++) await search.fill(index % 2 ? '' : 'No matching fixture')
  await settle()
  expect(await page.evaluate(ids => ids.every(id => document.querySelectorAll(`[data-testid="bot-${id}"]`).length === 1) && !document.querySelector('[data-motion-row][aria-hidden="true"]'), [bot.id, b.id, c.id])).toBe(true)
  record('open-menu-row-removed-and-sixteen-search-reversals-leave-no-ghosts')
  const total = await page.evaluate(async () => { for (let index = 0; index < 300; index++) await window.engram.botCreate({ name: `Bulk ${index}` }); return (await window.engram.botsList()).length })
  await expect(page.locator('[data-testid="sidebar-chats"] .bots-row')).toHaveCount(total, { timeout: 10_000 })
  await search.fill('Bulk 29'); await expect(page.locator('[data-testid="sidebar-chats"] li[data-motion-state="live"]')).toHaveCount(11)
  await search.fill(''); await settle(); await expect(page.locator('[data-testid="sidebar-chats"] li')).toHaveCount(total)
  record('three-hundred-row-filter-round-trip', { total })

  await openActivity(page, 'routines'); await expect(page.locator(fresh)).toHaveCount(0)
  await openActivity(page, 'bots'); await expect(page.locator(fresh)).toHaveCount(1)
  record('routine-mode-keeps-new-chat-absent')
  await visit(bot)
  for (const open of ['form', 'menu', 'session']) {
    if (open === 'session') await mouse(row(longB.id))
    else { await click(create); if (open === 'form') { await click(folder); await field.fill('Unsaved reload') } }
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await remember(); await menuClosed()
    await expect(page.locator(`${form}, [data-chat-snapshot]`)).toHaveCount(0)
  }
  expect(await folders('Unsaved reload')).toBe(0)
  for (let index = 0; index < 2; index++) { await openActivity(page, 'sky'); await openActivity(page, 'bots') }
  await mouse(row(c.id)); await shown(c); await usable('.bots-chat'); await settle(); await clean()
  record('reload-with-open-form-menu-and-session-exit-then-activity-round-trips', { errors })
  return { ok: evidence.every(record => record.pass) && !errors.length, evidence }
  } catch (error) { return { ok: false, evidence: [...evidence, { error: error.stack }] } }
}
