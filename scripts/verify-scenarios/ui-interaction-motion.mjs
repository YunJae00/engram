/* global window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, Element, Node, KeyboardEvent, innerWidth, innerHeight */
import { appendBotTurn, createBot } from '../../packages/core/src/index.ts'

export async function run(page, { expect, openActivity, app, paths }) {
  const evidence = [], errors = []
  try {
  page.on('pageerror', error => errors.push(error.message))
  // A never-shown window gets no compositor frames on Linux, so its transitions would stay pending.
  const resize = (width, height) => app.evaluate(({ BrowserWindow }, [width, height]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(Math.min(800, width), 560); win.setSize(width, height); if (process.platform === 'linux' && !win.isVisible()) win.showInactive() }, [width, height])
  await resize(1280, 900)
  // Two persisted forty-turn histories overflow the thread, so every visit scrolls to the bottom on mount.
  const longs = []; for (const name of ['Motion long A', 'Motion long B']) {
    const made = await createBot(paths, { name })
    for (let turn = 1; turn <= 40; turn++) await appendBotTurn(paths, made.id, { role: turn % 2 ? 'user' : 'assistant', text: turn === 40 ? `Closing turn forty of ${name}` : `${turn % 2 ? 'Question' : 'Answer'} ${turn} for ${name}.\nA second line keeps the bubble tall.\nA third line too.`, at: new Date().toISOString() })
    longs.push({ ...made, last: `Closing turn forty of ${name}` })
  }
  const [longA, longB] = longs; await page.reload(); await openActivity(page, 'bots')
  const names = ['Motion alpha', 'Motion beta', 'Motion gamma', 'Motion delta', 'Motion epsilon']
  const [bot, b, c, d, e] = await page.evaluate(async names => { const made = []; for (const name of names) made.push(await window.engram.botCreate({ name })); return made }, names)
  const row = id => `[data-testid="bot-${id}"]`
  await expect(page.locator(row(e.id))).toBeVisible()
  const create = '[data-testid="sidebar-create"]', fresh = '[data-testid="bots-new"]', folder = '[aria-label="New chat folder"]'
  const form = '.sidebar-folder-create', menu = '.sidebar-create-menu', input = '[aria-label="Folder name"]', thread = '[data-testid="bots-thread"]'
  const record = (label, detail = {}) => evidence.push({ label, ...detail, pass: detail.pass ?? true })
  const click = selector => page.evaluate(selector => document.querySelector(selector).click(), selector)
  const center = async selector => { const box = await page.locator(selector).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }
  const mouse = async selector => page.mouse.click(...await center(selector))
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot], [data-motion-state="exit"]:not(.sidebar-create-menu)') && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity), undefined, { timeout: 2000 })
  const shown = async one => { await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator(`${thread} .bots-hint`)).toContainText(one.name) }
  // A populated destination shows its last turn once, overflows, and rests at the bottom once auto-follow settles.
  const landed = async (one, bottom = true) => {
    await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator(thread)).toContainText(one.last)
    await expect.poll(() => page.evaluate(([last, bottom]) => { const list = window.motionLive(); return { copies: [...document.querySelectorAll('.bots-view .bots-thread:not([data-chat-snapshot]) .bubble-msg')].filter(node => node.textContent.includes(last)).length, threads: document.querySelectorAll('.bots-view .bots-thread:not([data-chat-snapshot])').length, overflow: list.scrollHeight > list.clientHeight, rest: !bottom || list.scrollHeight - list.clientHeight - list.scrollTop <= 2 } }, [one.last, bottom]), { timeout: 3000 }).toEqual({ copies: 1, threads: 1, overflow: true, rest: true })
  }
  const welcome = async () => { await expect(page.getByTestId('comet-welcome')).toBeVisible(); await expect(page.locator('.bots-row.active')).toHaveCount(0) }
  const usable = async scope => { const box = page.locator(`${scope} textarea`); await box.fill('Ready after navigation'); await expect(box).toHaveValue('Ready after navigation'); await box.fill('') }
  const residue = () => page.evaluate(() => ({ snapshots: document.querySelectorAll('[data-chat-snapshot]').length, owned: window.motionOwned().length }))
  const menuClosed = async () => {
    await expect(page.locator(menu)).toBeHidden()
    expect(await page.locator(menu).evaluate(node => node.inert && node.getAttribute('aria-hidden') === 'true' && !node.contains(document.activeElement) && document.querySelectorAll('[data-testid="bots-new"]').length === 1 && document.querySelector('[data-testid="bots-new"]') === window.motionNew && !window.motionNew.disabled)).toBe(true)
  }
  const prime = () => page.evaluate(() => {
    window.motionNew = document.querySelector('[data-testid="bots-new"]')
    window.motionLive = () => document.querySelector('.bots-view :is(.bots-thread, .comet-welcome):not([data-chat-snapshot])')
    window.motionOwned = () => document.getAnimations().filter(animation => animation.id.startsWith('chat-session-'))
    window.motionBox = node => { const rect = node?.getBoundingClientRect(); return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join() : '' }
    window.motionClick = event => ({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, box: window.motionBox(window.motionLive()), top: window.motionLive()?.scrollTop ?? 0 })
  })
  await prime(); await menuClosed()
  record('create-menu-retained-before-first-open')
  // With a target the probe samples that node's animations; without one it samples the owned session animations by id.
  const startProbe = (target, property = 'opacity') => page.evaluate(({ target, property }) => {
    const probe = window.motionProbe = { found: [], clicks: [], snapshots: 0, stopped: false }
    probe.click = event => probe.clicks.push(window.motionClick(event))
    document.addEventListener('click', probe.click, true)
    const scan = () => {
      if (probe.stopped) return
      probe.snapshots = Math.max(probe.snapshots, document.querySelectorAll('[data-chat-snapshot]').length)
      for (const animation of target ? document.querySelector(target)?.getAnimations() ?? [] : window.motionOwned()) {
        if (probe.found.some(record => record.animation === animation)) continue
        const effect = animation.effect, timing = effect.getTiming(), node = effect.target
        if (animation.transitionProperty && animation.transitionProperty !== property) continue
        animation.pause()
        const samples = [0, .25, .75, 1].map(fraction => { animation.currentTime = Number(timing.duration) * fraction; const style = getComputedStyle(node); return property === 'grid-template-rows' ? parseFloat(style.height) : Number(style.opacity) })
        animation.currentTime = 0
        probe.found.push({ animation, box: window.motionBox(node), id: animation.id, duration: timing.duration, easing: timing.easing === 'linear' ? effect.getKeyframes()[0]?.easing : timing.easing, samples, connected: node.isConnected, snapshot: node.matches('[data-chat-snapshot]'), keyed: !!node.closest('.bots-chat'), parent: node.parentElement?.className, surface: node.dataset.testid ?? '' })
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
  // The passive watcher only reads: per frame the owned pair, both surfaces and the scroll state, plus every scroll and click event.
  const watch = () => page.evaluate(() => {
    const seen = window.motionWatch = { frames: [], scrolls: [], clicks: [] }
    seen.scroll = event => { const node = event.target; seen.scrolls.push({ at: performance.now(), snapshot: !!node.closest?.('[data-chat-snapshot]'), target: node === document ? 'document' : node.dataset?.testid ?? String(node.className).split(' ')[0], top: node.scrollTop }) }
    seen.click = event => seen.clicks.push(window.motionClick(event))
    document.addEventListener('scroll', seen.scroll, true); document.addEventListener('click', seen.click, true)
    const tick = () => {
      const live = window.motionLive(), snapshot = document.querySelector('[data-chat-snapshot]')
      seen.frames.push({ at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, owned: window.motionOwned().map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime, connected: animation.effect.target.isConnected })),
        live: live && { opacity: Number(getComputedStyle(live).opacity), top: live.scrollTop, client: live.clientHeight, height: live.scrollHeight },
        snapshot: snapshot && { opacity: Number(getComputedStyle(snapshot).opacity), top: snapshot.scrollTop, box: window.motionBox(snapshot), testids: snapshot.querySelectorAll('[data-testid]').length, focused: snapshot.contains(document.activeElement) } })
      seen.frame = requestAnimationFrame(tick)
    }
    tick()
  })
  const unwatch = () => page.evaluate(() => { const seen = window.motionWatch; cancelAnimationFrame(seen.frame); document.removeEventListener('scroll', seen.scroll, true); document.removeEventListener('click', seen.click, true); return { frames: seen.frames, scrolls: seen.scrolls, clicks: seen.clicks } })
  const cleared = () => page.waitForFunction(() => window.motionWatch.frames.length > 3 && !document.querySelector('[data-chat-snapshot]') && !window.motionOwned().length, undefined, { timeout: 2000 })
  const near = (one, two) => one.split(',').every((value, index) => Math.abs(Number(value) - Number(two.split(',')[index])) <= 4)
  const monotone = (list, pick, sign) => list.length > 1 && list.every((one, index) => !index || Math.sign(pick(one) - pick(list[index - 1])) !== -sign) && Math.sign(pick(list.at(-1)) - pick(list[0])) === sign
  const pairs = frames => frames.filter(frame => frame.owned.length === 2 && frame.owned.every(one => one.state === 'running' && one.connected) && frame.snapshots === 1)
  const latest = frames => Math.max(0, ...frames.flatMap(frame => frame.owned.map(one => one.time)))
  // Natural lifetime: the pair runs while the incoming transcript scrolls to its bottom, and both leave within 300 ms.
  const judge = ({ frames, clicks, scrolls }, control, cached) => {
    const [first] = clicks, started = first?.at ?? 0, pair = pairs(frames)
    const gone = frames.find(frame => pair.length && frame.at > pair.at(-1).at && !frame.owned.length && !frame.snapshots)
    const mount = scrolls.find(one => one.at > started && !one.snapshot && one.target === 'bots-thread')
    const post = mount ? pair.filter(frame => frame.at > mount.at && frame.live && frame.snapshot) : []
    const checks = { trusted: clicks.length === 1 && first.trusted && first.target === control, pair: pair.length >= 2 && latest(pair) >= 120, cleared: !!gone && gone.at - started <= 300,
      held: frames.filter(frame => frame.snapshot).every(frame => frame.snapshot.top === first.top && near(frame.snapshot.box, first.box) && !frame.snapshot.testids && !frame.snapshot.focused),
      natural: !cached || (!!mount && mount.at < pair.at(-1)?.at && post.length >= 2 && post.some(frame => frame.owned.some(one => one.time >= 80)) && monotone(post, frame => frame.live.opacity, 1) && monotone(post, frame => frame.snapshot.opacity, -1)) }
    return { checks, mountScrollAt: mount ? mount.at - started : null, pairFrames: pair.length, postScrollFrames: post.length, lastPairTime: latest(pair), clearedAt: gone ? gone.at - started : null, scrolls: scrolls.map(one => ({ ...one, at: Math.round(one.at - started) })), pass: Object.values(checks).every(Boolean) }
  }
  const travel = async (label, selector, control, destination, cached) => {
    await settle(); await watch(); await mouse(selector); await cleared()
    if (destination.last) await landed(destination); else await welcome()
    evidence.push({ label, cached, ...judge(await unwatch(), control, cached) })
  }
  await travel('empty-to-long-a-first-visit', row(longA.id), `bot-${longA.id}`, longA, false)
  await travel('long-a-to-long-b-first-visit', row(longB.id), `bot-${longB.id}`, longB, false)
  await travel('long-b-to-long-a-cached-revisit', row(longA.id), `bot-${longA.id}`, longA, true)
  await travel('long-a-to-long-b-cached-revisit', row(longB.id), `bot-${longB.id}`, longB, true)
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await travel('long-b-to-new-chat', fresh, 'bots-new', {}, false)
  await travel('new-chat-to-long-a-cached-revisit', row(longA.id), `bot-${longA.id}`, longA, true)
  await usable('.bots-chat')
  const eased = (m, sign) => { const [start, quarter, later, end] = m.samples, range = end - start; return m.duration >= 120 && m.duration <= 260 && m.easing !== 'linear' && Math.abs(range) > .5 && Math.sign(range) === sign && Math.abs((quarter - start) / range - .25) > .05 && quarter !== later }
  async function measure(target, direction, preference, action, property = 'opacity', persistent = false) {
    await settle(); await startProbe(target, property); await action(); await frames()
    if (preference === 'no-preference') await page.waitForFunction(() => window.motionProbe.found.length > 0, undefined, { timeout: 800 }).catch(() => {})
    const { found } = await stopProbe()
    const retained = preference === 'reduce' && direction === 'exit' && !persistent ? await page.locator(target).count() : 0
    evidence.push({ target, direction, preference, measurements: found, retained, pass: preference === 'reduce' ? !retained && found.every(m => m.duration <= 1) : found.some(m => eased(m, direction === 'entry' ? 1 : -1)) })
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
  for (const preference of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: preference })
    await measure(menu, 'entry', preference, () => click(create))
    expect(await page.evaluate(() => document.activeElement === window.motionNew)).toBe(true)
    await measure(menu, 'exit', preference, () => page.keyboard.press('Escape'), 'opacity', true)
    await expect(page.getByTestId('sidebar-create')).toBeFocused(); await menuClosed()
    await click(create); await settle(); await page.getByTestId('topbar').click({ position: { x: 5, y: 5 } }); await menuClosed()
    await click(create)
    await measure(form, 'entry', preference, () => click(folder))
    await expect(page.locator(input)).toBeFocused()
    await measure(form, 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await click(create); await click(folder); await page.locator(input).fill(`Measured folder ${preference}`)
    await measure(form, 'exit', preference, () => page.keyboard.press('Enter'))
    expect(await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.filter(f => f.name === name).length, `Measured folder ${preference}`)).toBe(1)
    await click(create); await click(folder); await page.locator(input).fill('Cancelled folder'); await page.keyboard.press('Escape')
    await click(create); await click(folder); await settle(); await expect(page.locator(input)).toBeFocused()
    await page.locator(input).fill(' '); await page.keyboard.press('Enter'); await settle(); await expect(page.locator(input)).toHaveCount(0)
    record('escape-outside-focus-single-submit-reopen', { preference })
    const search = page.getByRole('textbox', { name: 'Search conversations' }), item = `li:has(${row(bot.id)})`
    await measure(item, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(item, 'entry', preference, () => search.fill(''))
    const folderId = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.find(f => f.name === name).id, `Measured folder ${preference}`)
    const folderRow = `[data-testid="sidebar-folder-${folderId}"]`
    await measure(folderRow, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(folderRow, 'entry', preference, () => search.fill(''))
    await mouse(row(bot.id)); await shown(bot)
    await session('thread-to-thread', preference, row(b.id), `bot-${b.id}`, 'bots-thread'); await shown(b)
    await mouse(create); await expect(page.locator(menu)).toBeVisible()
    await session('thread-to-new-chat', preference, fresh, 'bots-new', 'comet-welcome'); await welcome(); await usable('[data-testid="comet-welcome"]')
    await session('new-chat-to-thread', preference, row(bot.id), `bot-${bot.id}`, 'bots-thread'); await shown(bot); await usable('.bots-chat'); await menuClosed()
    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await measure('.delete-conversation-dialog', 'entry', preference, () => page.getByRole('button', { name: 'Delete', exact: true }).click())
    await page.mouse.click(5, 5); await expect(page.locator('.delete-conversation-dialog')).toBeVisible()
    await measure('.delete-conversation-dialog', 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.locator(row(bot.id))).toBeVisible()
    record('delete-backdrop-blocks-escape-closes', { preference })
    await page.evaluate(({ id, folder }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } }), { id: bot.id, folder: folderId })
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await prime()
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
      await click(toggle); await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true', { timeout: 150 })
      expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      record('disclosure-nine-toggles-focus-outside-then-preference-flip')
    }
    await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: null } }), bot.id)
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await prime()
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // Faults: reject fails the next mutation once; hold parks every mutation until released, each with its own verdict.
  await app.evaluate(({ ipcMain }) => {
    if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('IPC fault injection requires the Electron handler map')
    globalThis.motionFault = { originals: new Map(), calls: 0, mode: '', held: [] }
    for (const channel of ['sidebar:change', 'bots:delete']) {
      const original = ipcMain._invokeHandlers.get(channel)
      globalThis.motionFault.originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const fault = globalThis.motionFault
        fault.calls++
        if (fault.mode === 'reject') { fault.mode = ''; throw new Error('Motion fixture rejected mutation') }
        if (fault.mode === 'hold' && await new Promise(resolve => fault.held.push(resolve)) === 'reject') throw new Error('Motion fixture rejected held mutation')
        return original(event, ...args)
      })
    }
  })
  const calls = () => app.evaluate(() => globalThis.motionFault.calls), held = () => app.evaluate(() => globalThis.motionFault.held.length)
  const fault = mode => app.evaluate((_electron, mode) => { globalThis.motionFault.mode = mode; globalThis.motionFault.calls = 0 }, mode)
  const release = (order = 'first', verdict = 'ok') => app.evaluate((_electron, [order, verdict]) => globalThis.motionFault.held[order === 'last' ? 'pop' : 'shift']()(verdict), [order, verdict])
  const collection = page.getByTestId('sidebar-chat-collection'), folders = () => page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.folders.map(f => f.name))
  const openForm = async text => { await click(create); await click(folder); await expect(page.locator(input)).toBeFocused(); if (text) await page.locator(input).fill(text) }
  const editing = async text => { await expect(page.locator(input)).toHaveValue(text); await expect(page.locator(input)).toBeFocused() }
  const deleting = async id => { await click(`[data-testid="sidebar-chat-menu-${id}"]`); await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click() }
  try {
    await fault('reject'); await openForm('Rejected folder'); await page.keyboard.press('Enter')
    await expect(collection).toHaveAttribute('aria-busy', 'false')
    expect(await calls()).toBe(1); expect((await folders()).includes('Rejected folder')).toBe(false)
    await fault('hold'); await openForm('Pending folder'); await page.keyboard.press('Enter')
    await expect(collection).toHaveAttribute('aria-busy', 'true')
    await openForm('Fresh session'); await release()
    await expect(collection).toHaveAttribute('aria-busy', 'false'); await editing('Fresh session'); await page.keyboard.press('Escape')
    await openForm('Overlap one'); await page.keyboard.press('Enter'); await openForm('Overlap two'); await page.keyboard.press('Enter')
    await expect.poll(held).toBe(2); await openForm('Third form stays'); await release('last')
    await expect.poll(folders).toContain('Overlap two'); await expect(collection).toHaveAttribute('aria-busy', 'true'); await editing('Third form stays')
    await release('last'); await expect(collection).toHaveAttribute('aria-busy', 'false'); await editing('Third form stays')
    const made = await folders()
    record('two-held-folder-sessions-released-in-reverse-order', { calls: await calls(), pass: ['Overlap one', 'Overlap two'].every(name => made.filter(one => one === name).length === 1) })
    await page.keyboard.press('Escape'); await openForm('Late rejection'); await page.keyboard.press('Enter'); await expect.poll(held).toBe(1)
    await openForm('Newer form'); await release('first', 'reject')
    await expect(page.locator('.toast')).toContainText('Motion fixture rejected held mutation')
    await expect(collection).toHaveAttribute('aria-busy', 'false'); await editing('Newer form')
    record('old-rejection-after-newer-form-reports-and-keeps-editing', { pass: !(await folders()).includes('Late rejection') })
    await page.keyboard.press('Escape'); await fault(''); await openForm()
    await page.keyboard.insertText(`<i>🙂 Limit</i> ${'x'.repeat(5000)}`)
    const typed = await page.locator(input).inputValue()
    await page.locator(input).evaluate(node => { for (let index = 0; index < 3; index++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); node.blur() })
    await expect(page.locator('.sidebar-folder-head span', { hasText: '<i>🙂 Limit</i>' })).toHaveCount(1); await expect(collection).toHaveAttribute('aria-busy', 'false')
    record('triple-enter-blur-one-mutation-80-character-literal-text', { length: typed.length, calls: await calls(), pass: typed.length <= 80 && typed.length > 60 && await calls() === 1 && await page.locator('.sidebar-folder-head i').count() === 0 })
    await fault('reject'); await deleting(bot.id)
    await expect(page.locator('.delete-conversation-dialog [role="alert"]')).toBeVisible(); await page.keyboard.press('Escape')
    await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0); await expect(page.locator(row(bot.id))).toBeVisible()
    await fault('hold'); await deleting(d.id)
    await click('.delete-conversation-dialog .danger'); await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
    await expect(page.locator('.delete-conversation-dialog')).toBeVisible(); expect(await calls()).toBe(1)
    await release(); await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0); await expect(page.locator(row(d.id))).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await fault('')
    record('mutation-rejection-pending-session-held-delete-recovery')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      for (const resolve of globalThis.motionFault.held) resolve('ok')
      for (const [channel, original] of globalThis.motionFault.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.motionFault
    })
  }
  await mouse(row(bot.id)); await shown(bot)
  await session('same-row-click-discards-capture', 'no-preference', row(bot.id), `bot-${bot.id}`, null); await shown(bot)
  await openActivity(page, 'sky')
  await session('non-bots-activity-skips-motion', 'no-preference', row(b.id), `bot-${b.id}`, null); await shown(b)
  for (const [index, mode] of ['absent', 'throwing', 'capture'].entries()) {
    const target = [bot, b, c][index]
    await page.evaluate(mode => {
      window.motionAnimate = Element.prototype.animate; window.motionClone = Node.prototype.cloneNode
      if (mode === 'capture') Node.prototype.cloneNode = () => { throw new Error('Motion fixture capture failure') }
      else Element.prototype.animate = mode === 'absent' ? undefined : () => { throw new Error('Motion fixture animate failure') }
    }, mode)
    try { await session(`${mode === 'capture' ? 'snapshot-capture' : 'element-animate'}-${mode}-navigation-completes`, 'no-preference', row(target.id), `bot-${target.id}`, null) }
    finally { await page.evaluate(() => { Element.prototype.animate = window.motionAnimate; Node.prototype.cloneNode = window.motionClone }) }
    await shown(target); await usable('.bots-chat'); expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  }
  const during = []; for (const delay of [0, 60, 120, 180, 240]) for (const second of [row(longA.id), create]) {
    await mouse(row(longA.id)); await landed(longA); await settle()
    const first = await center(row(longB.id)), next = await center(second)
    await startProbe(null); await page.mouse.click(...first)
    if (delay) await page.waitForTimeout(delay)
    await page.mouse.click(...next)
    const { clicks, snapshots } = await stopProbe()
    const elapsed = clicks[1]?.at - clicks[0]?.at, targets = clicks.map(one => one.target), midMotion = clicks[1]?.snapshots === 1
    if (second === create) { await expect(page.locator(menu)).toBeVisible(); await expect(page.locator(fresh)).toBeFocused(); await landed(longB); await page.keyboard.press('Escape'); await menuClosed() }
    else await landed(longA)
    during.push(midMotion)
    evidence.push({ label: 'timed-trusted-double-click', delay, elapsed, targets, midMotion, snapshots, pass: clicks.length === 2 && clicks.every(one => one.trusted) && targets[0] === `bot-${longB.id}` && targets[1] === (second === create ? 'sidebar-create' : `bot-${longA.id}`) && elapsed >= delay && (elapsed > 120 || midMotion) && snapshots <= 1 })
  }
  record('second-click-landed-while-exit-snapshot-present', { pass: during.slice(0, 2).every(Boolean) })
  await settle(); await watch(); await mouse(row(longB.id)); await mouse(row(c.id)); await mouse(row(longA.id))
  const chain = await unwatch(); await landed(longA); await page.waitForTimeout(300); await landed(longA)
  record('real-b-c-a-sequence-ends-at-a-without-settling', { targets: chain.clicks.map(one => one.target), residue: await residue(), pass: chain.clicks.length === 3 && chain.clicks.every(one => one.trusted) && chain.clicks.map(one => one.target).join() === [longB, c, longA].map(one => `bot-${one.id}`).join() && (await residue()).snapshots === 0 && (await residue()).owned === 0 })
  await settle(); const storm = await page.evaluate(({ rows }) => {
    const press = id => { document.querySelector(`[data-testid="bot-${id}"]`).click(); return document.querySelector(`[data-testid="bot-${id}"]`).classList.contains('active') && document.querySelectorAll('.bots-row.active').length === 1 }
    const count = () => document.querySelectorAll('[data-chat-snapshot]').length + window.motionOwned().length
    const pair = press(rows[1]) && press(rows[0])
    let handled = 0, most = 0
    for (let index = 0; index < 60; index++) { handled += Number(press(rows[(index + 1) % 3])); most = Math.max(most, count()) }
    return { pair, handled, most }
  }, { rows: [bot.id, b.id, c.id] })
  await shown(bot); await page.waitForTimeout(300); await shown(bot); await usable('.bots-chat')
  record('synthetic-pair-and-sixty-click-storm-each-handled-in-order', { ...storm, residue: await residue(), pass: storm.pair && storm.handled === 60 && storm.most <= 3 && (await residue()).snapshots === 0 && (await residue()).owned === 0 })
  let flip; for (let attempt = 0; attempt < 3 && !(flip?.elapsed < 150); attempt++) {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await mouse(row(longA.id)); await landed(longA); await settle(); await startProbe(null); await mouse(row(longB.id))
    const started = await residue()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const ended = await (await page.waitForFunction(() => !document.querySelector('[data-chat-snapshot]') && !window.motionOwned().length && performance.now())).jsonValue()
    flip = { elapsed: ended - (await stopProbe()).clicks[0].at, started }
  }
  await landed(longB); await usable('.bots-chat')
  record('reduce-preference-mid-session-cancels-before-natural-end', { ...flip, pass: flip.elapsed < 150 && flip.started.snapshots === 1 && flip.started.owned === 2 })
  await settle(); await watch(); await mouse(row(longA.id)); await landed(longA)
  const quiet = await unwatch(); record('reduced-motion-populated-navigation-runs-no-pair', { frames: quiet.frames.length, pass: quiet.clicks.length === 1 && quiet.clicks[0].trusted && quiet.frames.length > 2 && quiet.frames.every(frame => !frame.owned.length && !frame.snapshots) })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mouse(create); await expect(page.locator(menu)).toBeVisible(); await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator(menu)).toBeHidden({ timeout: 120 }); await menuClosed()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await click(create); await click(folder); await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await frames(); await expect(page.locator(form)).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  record('reduce-preference-mid-menu-and-form-exit')
  // A wheel scroll upward during the pair moves the live transcript and leaves the motion running.
  await settle(); await watch()
  const [threadX, threadY] = await center(thread)
  await mouse(row(longB.id)); await page.mouse.move(threadX, threadY); await page.mouse.wheel(0, -600); await cleared()
  const wheeled = await unwatch(); await landed(longB, false)
  const bottomed = wheeled.frames.findIndex(frame => frame.live && frame.live.height - frame.live.client - frame.live.top <= 2)
  const dropped = wheeled.frames.findIndex((frame, index) => bottomed >= 0 && index > bottomed && frame.live && frame.live.top < wheeled.frames[bottomed].live.top - 50)
  const rest = await page.evaluate(() => { const list = window.motionLive(); return list.scrollHeight - list.clientHeight - list.scrollTop })
  record('wheel-scroll-upward-during-motion-moves-live-transcript-and-motion-survives', { bottomed, dropped, rest, pass: bottomed >= 0 && dropped > bottomed && pairs(wheeled.frames.slice(dropped)).length > 0 && rest > 50 })
  let cut; for (let attempt = 0; attempt < 3 && !(cut?.lastPairTime < 150); attempt++) {
    await mouse(row(longA.id)); await landed(longA); await settle(); await watch()
    await mouse(row(longB.id)); await resize(1200, 860); await cleared()
    const seen = await unwatch()
    cut = { lastPairTime: latest(pairs(seen.frames)), pairFrames: pairs(seen.frames).length }
    await resize(1280, 900); await page.waitForFunction(() => innerWidth === 1280)
  }
  await landed(longB); await usable('.bots-chat')
  record('resize-mid-motion-ends-pair-early-and-destination-usable', { ...cut, pass: cut.pairFrames >= 1 && cut.lastPairTime < 150 })
  for (let index = 0; index < 21; index++) await mouse(create)
  await expect(page.locator(menu)).toBeVisible()
  expect(await page.locator(menu).evaluate(node => !node.inert && node.getAttribute('aria-hidden') === 'false' && document.querySelector('[data-testid="bots-new"]') === window.motionNew)).toBe(true)
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await menuClosed()
  await mouse(create); await mouse(create); await menuClosed()
  await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await mouse(row(b.id)); await shown(b); await menuClosed()
  record('twenty-one-toggles-tab-and-outside-click-keep-destination-action')
  const widths = []; for (const width of [620, 400, 1280]) {
    await resize(width, 900); await page.waitForFunction(width => Math.abs(innerWidth - width) < 40, width)
    if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
    await settle(); await mouse(create); await expect(page.locator(menu)).toBeVisible(); await settle()
    widths.push(await page.locator(menu).evaluate(node => { const box = node.getBoundingClientRect(); return { innerWidth, left: box.left, right: box.right, bottom: box.bottom, inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight } }))
    await page.keyboard.press('Escape'); await menuClosed()
    if (width === 620) { await mouse(row(bot.id)); await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true'); await shown(bot) }
  }
  record('create-menu-inside-viewport-and-narrow-navigation-toggles-sidebar-once', { widths, pass: widths.every(one => one.inside) })
  await click(`[data-testid="sidebar-chat-menu-${e.id}"]`); await expect(page.locator('.sidebar-organize-menu')).toBeVisible()
  await page.evaluate(id => window.engram.botDelete(id), e.id)
  await expect(page.locator('.sidebar-organize-menu')).toHaveCount(0); await expect(page.locator(row(e.id))).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Search conversations' })
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
  await mouse(row(bot.id)); await shown(bot); await settle()
  for (const open of ['form', 'menu', 'session']) {
    if (open === 'session') await mouse(row(b.id))
    else { await click(create); if (open === 'form') { await click(folder); await page.locator(input).fill('Unsaved reload') } }
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await prime(); await menuClosed()
    await expect(page.locator(`${form}, [data-chat-snapshot]`)).toHaveCount(0)
  }
  expect((await folders()).includes('Unsaved reload')).toBe(false)
  for (let index = 0; index < 2; index++) { await openActivity(page, 'sky'); await openActivity(page, 'bots') }
  await mouse(row(c.id)); await shown(c); await usable('.bots-chat'); await settle()
  expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  record('reload-with-open-form-menu-and-session-exit-then-activity-round-trips', { errors })
  return { ok: evidence.every(record => record.pass) && !errors.length, evidence }
  } catch (error) { return { ok: false, evidence: [...evidence, { error: error.stack }] } }
}
