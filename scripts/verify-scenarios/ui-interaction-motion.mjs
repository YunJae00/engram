/* global window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle, Element, Node, KeyboardEvent, innerWidth, innerHeight */
import { appendBotTurn, createBot } from '../../packages/core/src/index.ts'

const LIVE = '.bots-view :is(.bots-thread, .comet-welcome):not([data-chat-snapshot])'

export async function run(page, { expect, openActivity, app, paths }) {
  const evidence = [], errors = []
  try {
  page.on('pageerror', error => errors.push(error.message))
  // A window that is never shown gets no real frames, so motion is measured on a shown window.
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 900); if (!win.isVisible()) win.show() })
  await openActivity(page, 'bots')
  const names = ['Motion alpha', 'Motion beta', 'Motion gamma', 'Motion delta', 'Motion epsilon']
  const [bot, b, c, d, e] = await page.evaluate(async names => { const made = []; for (const name of names) made.push(await window.engram.botCreate({ name })); return made }, names)
  // Two persisted 40-turn histories overflow the 1280x900 thread, so mount and load scrolling really happens under motion.
  const long = []
  for (const name of ['Motion history A', 'Motion history B']) {
    const made = await createBot(paths, { name }), last = `${name} closing turn forty`
    for (let index = 0; index < 40; index++) await appendBotTurn(paths, made.id, { role: index % 2 ? 'assistant' : 'user', text: index === 39 ? last : `${name} turn ${index + 1}\nsecond line of turn ${index + 1}\nthird line keeps the bubble tall`, at: new Date(Date.now() - (40 - index) * 60_000).toISOString() })
    long.push({ ...made, last })
  }
  const [longA, longB] = long
  const old = await createBot(paths, { name: 'Motion archive' }, new Date(Date.now() - 3 * 86_400_000))
  await page.reload(); await openActivity(page, 'bots')
  const row = id => `[data-testid="bot-${id}"]`
  await expect(page.locator(row(longB.id))).toBeVisible()
  const create = '[data-testid="sidebar-create"]', fresh = '[data-testid="bots-new"]', folder = '[aria-label="New chat folder"]'
  const form = '.sidebar-folder-create', menu = '.sidebar-create-menu', input = '[aria-label="Folder name"]', thread = '[data-testid="bots-thread"]'
  const record = (label, detail = {}) => evidence.push({ label, ...detail, pass: detail.pass ?? true })
  const click = selector => page.evaluate(selector => document.querySelector(selector).click(), selector)
  const center = async selector => { const box = await page.locator(selector).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }
  const mouse = async selector => page.mouse.click(...await center(selector))
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot], [data-motion-state="exit"]:not(.sidebar-create-menu)') && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity), undefined, { timeout: 2000 })
  const shown = async one => { await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator(`${thread} .bots-hint`)).toContainText(one.name) }
  // A populated destination is landed once its final turn is live exactly once and auto-follow rests at the foot.
  const landed = async one => {
    await expect(page.locator(row(one.id))).toHaveClass(/active/); await expect(page.locator(thread)).toContainText(one.last)
    await expect.poll(() => page.locator(thread).evaluate((node, last) => ({ overflow: node.scrollHeight > node.clientHeight, footed: Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2, copies: [...node.querySelectorAll('.bubble-msg')].filter(bubble => bubble.textContent.includes(last)).length }), one.last), { timeout: 4000 }).toEqual({ overflow: true, footed: true, copies: 1 })
  }
  const welcome = async () => { await expect(page.getByTestId('comet-welcome')).toBeVisible(); await expect(page.locator('.bots-row.active')).toHaveCount(0) }
  const usable = async scope => { const box = page.locator(`${scope} textarea`); await box.fill('Ready after navigation'); await expect(box).toHaveValue('Ready after navigation'); await box.fill('') }
  const residue = () => page.evaluate(() => ({ snapshots: document.querySelectorAll('[data-chat-snapshot]').length, owned: document.getAnimations().filter(animation => animation.id.startsWith('chat-session-')).length }))
  const menuClosed = async () => {
    await expect(page.locator(menu)).toBeHidden()
    expect(await page.locator(menu).evaluate(node => node.inert && node.getAttribute('aria-hidden') === 'true' && !node.contains(document.activeElement) && document.querySelectorAll('[data-testid="bots-new"]').length === 1 && document.querySelector('[data-testid="bots-new"]') === window.motionNew && !window.motionNew.disabled)).toBe(true)
  }
  const rememberNew = () => page.evaluate(() => { window.motionNew = document.querySelector('[data-testid="bots-new"]') })
  await rememberNew(); await menuClosed(); record('create-menu-retained-before-first-open')
  // With a target the probe samples that node's animations; without one it samples the owned session animations by id.
  const startProbe = (target, property = 'opacity') => page.evaluate(({ target, property, LIVE }) => {
    const probe = window.motionProbe = { found: [], clicks: [], snapshots: 0, stopped: false }
    const owned = () => document.getAnimations().filter(animation => animation.id.startsWith('chat-session-'))
    const box = node => { const rect = node?.getBoundingClientRect(); return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join() : '' }
    probe.click = event => probe.clicks.push({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, box: box(document.querySelector(LIVE)) })
    document.addEventListener('click', probe.click, true)
    const scan = () => {
      if (probe.stopped) return
      probe.snapshots = Math.max(probe.snapshots, document.querySelectorAll('[data-chat-snapshot]').length)
      for (const animation of target ? document.querySelector(target)?.getAnimations() ?? [] : owned()) {
        if (probe.found.some(record => record.animation === animation) || (animation.transitionProperty && animation.transitionProperty !== property)) continue
        const effect = animation.effect, timing = effect.getTiming(), node = effect.target
        animation.pause()
        const samples = [0, .25, .75, 1].map(fraction => { animation.currentTime = Number(timing.duration) * fraction; const style = getComputedStyle(node); return property === 'grid-template-rows' ? parseFloat(style.height) : Number(style.opacity) })
        animation.currentTime = 0
        probe.found.push({ animation, box: box(node), id: animation.id, duration: timing.duration, easing: timing.easing === 'linear' ? effect.getKeyframes()[0]?.easing : timing.easing, samples, connected: node.isConnected, snapshot: node.matches('[data-chat-snapshot]'), keyed: !!node.closest('.bots-chat'), parent: node.parentElement?.className, surface: node.dataset.testid ?? '' })
        animation.play()
      }
      probe.frame = requestAnimationFrame(scan)
    }
    scan()
  }, { target, property, LIVE })
  const stopProbe = () => page.evaluate(() => {
    const probe = window.motionProbe; probe.stopped = true; cancelAnimationFrame(probe.frame); document.removeEventListener('click', probe.click, true)
    return { found: probe.found.map(record => ({ ...record, animation: undefined })), clicks: probe.clicks, snapshots: probe.snapshots }
  })
  const eased = (m, sign) => {
    const [start, quarter, later, end] = m.samples, range = end - start
    return m.duration >= 120 && m.duration <= 260 && m.easing !== 'linear' && Math.abs(range) > .5 && Math.sign(range) === sign && Math.abs((quarter - start) / range - .25) > .05 && quarter !== later
  }
  async function measure(target, direction, preference, action, property = 'opacity', persistent = false) {
    await settle(); await startProbe(target, property); await action(); await frames()
    if (preference === 'no-preference') await page.waitForFunction(() => window.motionProbe.found.length > 0, undefined, { timeout: 800 }).catch(() => {})
    const { found } = await stopProbe(), retained = preference === 'reduce' && direction === 'exit' && !persistent ? await page.locator(target).count() : 0
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
    const { found, clicks, snapshots } = await stopProbe(), enter = found.find(m => m.id === 'chat-session-enter'), exit = found.find(m => m.id === 'chat-session-exit')
    const trusted = clicks.length === 1 && clicks[0].trusted && clicks[0].target === control
    const moved = !!enter && !!exit && eased(enter, 1) && eased(exit, -1) && enter.connected && !enter.snapshot && enter.surface === surface && exit.connected && exit.snapshot && !exit.keyed && exit.parent === 'bots-view' && exit.box === clicks[0].box && snapshots === 1
    evidence.push({ label, preference, clicks, measurements: found, snapshots, pass: trusted && (preference === 'reduce' || !surface ? !found.length && !snapshots : moved) })
    await settle()
  }
  // The passive watch never pauses or seeks: every frame records the owned pair, both surfaces, the live scroller and real scroll events.
  const startWatch = () => page.evaluate(LIVE => {
    const watch = window.motionWatch = { samples: [], scrolls: [], clicks: [], stopped: false }
    const live = () => document.querySelector(LIVE), snapshot = () => document.querySelector('[data-chat-snapshot]')
    const box = node => { const rect = node?.getBoundingClientRect(); return rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join() : '' }
    const describe = node => node ? { opacity: Number(getComputedStyle(node).opacity), transform: getComputedStyle(node).transform, connected: node.isConnected, scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, bubbles: node.querySelectorAll('.bubble-msg').length, box: box(node), testIds: node.querySelectorAll('[data-testid]').length, inert: node.inert, focusWithin: node.contains(document.activeElement) } : null
    watch.click = event => watch.clicks.push({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now(), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, box: box(live()), scrollTop: live()?.scrollTop ?? 0 })
    watch.scroll = event => { const node = event.target; watch.scrolls.push({ at: performance.now(), target: node === document ? 'document' : node.closest?.('[data-chat-snapshot]') ? 'snapshot' : node.matches?.('[data-testid="bots-thread"]') ? 'live' : node.className || node.nodeName, scrollTop: node.scrollTop }) }
    document.addEventListener('click', watch.click, true); document.addEventListener('scroll', watch.scroll, true)
    const tick = () => {
      if (watch.stopped) return
      const owned = document.getAnimations().filter(animation => animation.id.startsWith('chat-session-'))
      watch.samples.push({ at: performance.now(), owned: owned.map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime, connected: animation.effect.target.isConnected })), snapshots: document.querySelectorAll('[data-chat-snapshot]').length, live: describe(live()), snapshot: describe(snapshot()) })
      watch.frame = requestAnimationFrame(tick)
    }
    tick()
  }, LIVE)
  const stopWatch = () => page.evaluate(() => {
    const watch = window.motionWatch; watch.stopped = true; cancelAnimationFrame(watch.frame); document.removeEventListener('click', watch.click, true); document.removeEventListener('scroll', watch.scroll, true); delete window.motionWatch
    return { samples: watch.samples, scrolls: watch.scrolls, clicks: watch.clicks }
  })
  const cleared = () => page.waitForFunction(() => !document.querySelector('[data-chat-snapshot]') && !document.getAnimations().some(animation => animation.id.startsWith('chat-session-')), undefined, { timeout: 1500 }).catch(() => {})
  const summarize = ({ samples, scrolls, clicks }) => {
    const click = clicks[0], start = samples.find(sample => sample.owned.length === 2), since = sample => click && sample.at >= click.at
    const running = samples.filter(sample => sample.owned.length === 2 && sample.owned.every(one => one.state === 'running' && one.connected) && sample.snapshots === 1 && sample.live && sample.snapshot)
    const liveScrolls = scrolls.filter(one => one.target === 'live' && since(one)), scroll = liveScrolls[0], after = scroll ? running.filter(sample => sample.at > scroll.at) : []
    const opposite = after.length >= 2 && after.every((sample, index) => !index || (sample.live.opacity >= after[index - 1].live.opacity && sample.snapshot.opacity <= after[index - 1].snapshot.opacity)) && after.at(-1).live.opacity > after[0].live.opacity && after.at(-1).snapshot.opacity < after[0].snapshot.opacity
    const times = running.flatMap(sample => sample.owned.map(one => one.time)), end = start && samples.find(sample => sample.at > start.at && !sample.owned.length && !sample.snapshots)
    const first = samples.find(sample => sample.snapshot), loaded = samples.find(sample => since(sample) && sample.live?.bubbles)
    const captured = !!first && first.snapshot.box === click?.box && Math.abs(first.snapshot.scrollTop - click.scrollTop) <= 1 && first.snapshot.testIds === 0 && first.snapshot.inert && !first.snapshot.focusWithin
    const held = !!click && samples.filter(sample => sample.snapshot).every(sample => Math.abs(sample.snapshot.scrollTop - click.scrollTop) <= 1)
    const timing = { scrollAt: scroll ? Math.round(scroll.at - click.at) : null, loadedAt: loaded ? Math.round(loaded.at - click.at) : null, startedAt: start && click ? Math.round(start.at - click.at) : null, clearedIn: end ? Math.round(end.at - start.at) : null, scrollBeforeEnd: !!scroll && !!end && scroll.at < end.at }
    return { trusted: !!click?.trusted, target: click?.target, started: !!start, samples: samples.length, liveScrolls: liveScrolls.length, postScroll: after.length, spaced: after.length >= 2 && after.at(-1).at - after[0].at >= 8, opposite, mid: times.some(time => time >= 80), late: times.some(time => time >= 120), captured, held, ...timing, snapshots: Math.max(0, ...samples.map(sample => sample.snapshots)), ownedMost: Math.max(0, ...samples.map(sample => sample.owned.length)) }
  }
  // One trusted navigation under the passive watch; cached destinations must keep animating after their mount scroll.
  async function travel(label, control, destination, { cached = false, fromLong = false } = {}) {
    await settle(); await startWatch()
    let data
    try { await mouse(control); await cleared(); await frames() } finally { data = await stopWatch() }
    const summary = summarize(data); if (destination) await landed(destination); else await welcome()
    const pass = summary.trusted && summary.started && summary.clearedIn !== null && summary.clearedIn <= 300 && summary.snapshots === 1 && summary.ownedMost === 2 && (!fromLong || (summary.captured && summary.held)) && (!cached || (summary.liveScrolls > 0 && summary.postScroll >= 2 && summary.spaced && summary.opposite && summary.mid && summary.late))
    evidence.push({ label, cached, ...summary, pass })
  }
  for (const preference of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: preference })
    await measure(menu, 'entry', preference, () => click(create)); expect(await page.evaluate(() => document.activeElement === window.motionNew)).toBe(true)
    await measure(menu, 'exit', preference, () => page.keyboard.press('Escape'), 'opacity', true); await expect(page.getByTestId('sidebar-create')).toBeFocused(); await menuClosed()
    await click(create); await settle(); await page.getByTestId('topbar').click({ position: { x: 5, y: 5 } }); await menuClosed()
    await click(create); await measure(form, 'entry', preference, () => click(folder)); await expect(page.locator(input)).toBeFocused()
    await measure(form, 'exit', preference, () => page.keyboard.press('Escape')); await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await click(create); await click(folder); await page.locator(input).fill(`Measured folder ${preference}`)
    await measure(form, 'exit', preference, () => page.keyboard.press('Enter'))
    expect(await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.filter(f => f.name === name).length, `Measured folder ${preference}`)).toBe(1)
    await click(create); await click(folder); await page.locator(input).fill('Cancelled folder'); await page.keyboard.press('Escape')
    await click(create); await click(folder); await settle(); await expect(page.locator(input)).toBeFocused()
    await page.locator(input).fill(' '); await page.keyboard.press('Enter'); await settle(); await expect(page.locator(input)).toHaveCount(0)
    record('escape-outside-focus-single-submit-reopen', { preference })

    const search = page.getByRole('textbox', { name: 'Search conversations' }), item = `li:has(${row(bot.id)})`
    await measure(item, 'exit', preference, () => search.fill('No matching fixture')); await measure(item, 'entry', preference, () => search.fill(''))
    const folderId = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.find(f => f.name === name).id, `Measured folder ${preference}`)
    const folderRow = `[data-testid="sidebar-folder-${folderId}"]`
    await measure(folderRow, 'exit', preference, () => search.fill('No matching fixture')); await measure(folderRow, 'entry', preference, () => search.fill(''))

    await mouse(row(bot.id)); await shown(bot)
    await session('thread-to-thread', preference, row(b.id), `bot-${b.id}`, 'bots-thread'); await shown(b)
    await mouse(create); await expect(page.locator(menu)).toBeVisible()
    await session('thread-to-new-chat', preference, fresh, 'bots-new', 'comet-welcome'); await welcome(); await usable('[data-testid="comet-welcome"]')
    await session('new-chat-to-thread', preference, row(bot.id), `bot-${bot.id}`, 'bots-thread'); await shown(bot); await usable('.bots-chat'); await menuClosed()

    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await measure('.delete-conversation-dialog', 'entry', preference, () => page.getByRole('button', { name: 'Delete', exact: true }).click())
    await page.mouse.click(5, 5); await expect(page.locator('.delete-conversation-dialog')).toBeVisible()
    await measure('.delete-conversation-dialog', 'exit', preference, () => page.keyboard.press('Escape')); await expect(page.locator(row(bot.id))).toBeVisible()
    record('delete-backdrop-blocks-escape-closes', { preference })
    await page.evaluate(({ id, folder }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } }), { id: bot.id, folder: folderId })
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible()
    const disclosure = `#folder-${folderId}`, toggle = `[aria-controls="folder-${folderId}"]`
    await measure(disclosure, 'exit', preference, () => click(toggle), 'grid-template-rows', true); await expect(page.locator(disclosure)).toHaveAttribute('aria-hidden', 'true')
    await measure(disclosure, 'entry', preference, () => click(toggle), 'grid-template-rows', true); await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true')
    expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
    if (preference === 'no-preference') {
      await page.locator(row(bot.id)).focus()
      for (let index = 0; index < 9; index++) { await click(toggle); await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', String(index % 2 === 1)) }; await settle()
      expect(await page.locator(disclosure).evaluate(node => node.getAttribute('aria-hidden') === 'true' && node.firstElementChild.inert && getComputedStyle(node).visibility === 'hidden' && !node.contains(document.activeElement))).toBe(true)
      await click(toggle); await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true', { timeout: 150 }); expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' }); record('disclosure-nine-toggles-focus-outside-then-preference-flip')
    }
    await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: null } }), bot.id)
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await rememberNew()
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await mouse(row(bot.id)); await shown(bot); await settle(); await travel('empty-to-long-first-visit', row(longA.id), longA)
  await travel('long-to-long-first-visit', row(longB.id), longB, { fromLong: true })
  await travel('long-to-long-cached-revisit', row(longA.id), longA, { cached: true, fromLong: true })
  await mouse(row(bot.id)); await shown(bot); await travel('empty-to-long-cached-revisit', row(longA.id), longA, { cached: true })
  await mouse(create); await expect(page.locator(menu)).toBeVisible(); await travel('long-to-new-chat', fresh, null, { fromLong: true }); await usable('[data-testid="comet-welcome"]')
  await travel('new-chat-to-long-cached-revisit', row(longB.id), longB, { cached: true }); await usable('.bots-chat')
  // A real wheel upward while the pair runs: the live transcript moves and the motion keeps going.
  await settle(); await startWatch()
  let wheel
  try { await mouse(row(longA.id)); await page.mouse.move(...await center(thread)); await page.mouse.wheel(0, -320); await cleared(); await frames() } finally { wheel = await stopWatch() }
  const lives = wheel.scrolls.filter(one => one.target === 'live'), foot = Math.max(0, ...lives.map(one => one.scrollTop))
  const up = lives.find(one => one.scrollTop < foot && one.at > wheel.clicks[0]?.at), before = up && wheel.samples.filter(sample => sample.at < up.at).at(-1), afterUp = up && wheel.samples.find(sample => sample.at > up.at && sample.owned.length === 2)
  await expect(page.locator(row(longA.id))).toHaveClass(/active/); await expect(page.locator(thread)).toContainText(longA.last); await usable('.bots-chat')
  record('wheel-up-during-long-motion-survives', { ...summarize(wheel), upAt: up ? Math.round(up.at - wheel.clicks[0].at) : null, resting: wheel.samples.at(-1)?.live?.scrollTop, residue: await residue(), pass: !!before?.owned.length && !!afterUp && afterUp.live.scrollTop < before.live.scrollTop && afterUp.live.scrollTop < foot })
  await page.emulateMedia({ reducedMotion: 'reduce' }); await session('reduce-preference-long-history-no-pair', 'reduce', row(longB.id), `bot-${longB.id}`, 'bots-thread'); await landed(longB)
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await settle(); await startWatch()
  let resized
  try { await mouse(row(longA.id)); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 900)); await cleared(); await frames() } finally { resized = summarize(await stopWatch()) }
  await landed(longA); await usable('.bots-chat'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  record('resize-during-long-motion-cleans-up-and-keeps-destination', { ...resized, residue: await residue(), pass: resized.trusted && resized.started && resized.clearedIn !== null && resized.clearedIn < 250 })
  // Show and Hide earlier commit in the click itself, so a trusted click right after reaches its row and never a document overlay.
  const earlier = '[data-testid="sidebar-earlier"]', setEarlier = async open => { if (await page.locator(earlier).getAttribute('aria-expanded') !== String(open)) await click(earlier); await expect(page.locator(earlier)).toHaveAttribute('aria-expanded', String(open)); await settle() }
  await mouse(row(bot.id)); await shown(bot); await expect(page.locator(earlier)).toHaveAttribute('aria-expanded', 'false'); await expect(page.locator(row(old.id))).toHaveCount(0)
  const collapsedB = await center(row(b.id)); await setEarlier(true); const oldAt = await center(row(old.id)), expandedB = await center(row(b.id)); await setEarlier(false)
  record('earlier-collapsed-old-row-absent-recent-target-stable', { collapsedB, expandedB, pass: collapsedB.join() === expandedB.join() })
  async function afterEarlier(label, open, delay, targets) {
    await mouse(row(bot.id)); await shown(bot); await setEarlier(!open)
    const from = await center(earlier), points = await Promise.all(targets.map(one => one === old.id && open ? oldAt : one === create ? center(create) : center(row(one)))), last = targets.at(-1), result = {}
    await page.evaluate(() => { const probe = window.earlierProbe = { clicks: [], calls: 0, original: document.startViewTransition }; probe.click = event => probe.clicks.push({ trusted: event.isTrusted, target: event.target.closest('[data-testid]')?.dataset.testid ?? event.target.tagName, at: performance.now() }); document.addEventListener('click', probe.click, true); if (probe.original) document.startViewTransition = function () { probe.calls++; return probe.original.apply(this, arguments) } })
    try {
      await page.mouse.click(...from); if (delay) await page.waitForTimeout(delay)
      for (const point of points) await page.mouse.click(...point)
      const active = () => last === create ? page.locator(menu).isVisible() : page.locator(row(last)).evaluate(node => node.classList.contains('active'))
      result.immediate = await active(); await page.waitForTimeout(400); result.still = await active(); result.expanded = await page.locator(earlier).count() ? await page.locator(earlier).getAttribute('aria-expanded') : 'selected-old-is-recent'
    } finally { Object.assign(result, await page.evaluate(() => { const probe = window.earlierProbe; document.removeEventListener('click', probe.click, true); if (probe.original) delete document.startViewTransition; delete window.earlierProbe; return { clicks: probe.clicks, calls: probe.calls } })) }
    if (last === create) { await page.keyboard.press('Escape'); await menuClosed() }
    const elapsed = result.clicks[1] && Math.round(result.clicks[1].at - result.clicks[0].at), names = result.clicks.map(one => one.target), timely = elapsed >= delay && (delay >= 400 || elapsed < 250) && (delay > 0 || elapsed < 100)
    evidence.push({ label, open, delay, elapsed, timely, ...result, pass: timely && result.immediate && result.still && result.calls === 0 && (result.expanded === String(open) || last === old.id) && result.clicks.every(one => one.trusted) && names.join() === ['sidebar-earlier', ...targets.map(one => one === create ? 'sidebar-create' : `bot-${one}`)].join() })
  }
  for (const delay of [0, 40, 100, 200, 400]) for (const [open, target] of [[true, b.id], [true, old.id], [false, b.id]]) await afterEarlier(`${open ? 'show' : 'hide'}-earlier-then-trusted-row-click`, open, delay, [target])
  await afterEarlier('show-earlier-then-create', true, 0, [create]); await afterEarlier('show-earlier-then-b-a-chain', true, 0, [b.id, c.id]); await page.emulateMedia({ reducedMotion: 'reduce' }); for (const open of [true, false]) await afterEarlier('reduce-earlier-then-row-click', open, 0, [b.id])
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await setEarlier(true)

  await app.evaluate(({ ipcMain }) => {
    if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('IPC fault injection requires the Electron handler map')
    const fault = globalThis.motionFault = { originals: new Map(), calls: 0, modes: [], holds: [] }
    for (const channel of ['sidebar:change', 'bots:delete']) {
      const original = ipcMain._invokeHandlers.get(channel)
      fault.originals.set(channel, original); ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        fault.calls++
        const mode = fault.modes.shift() ?? ''
        if (mode === 'reject') throw new Error('Motion fixture rejected mutation')
        if (mode === 'hold') await new Promise((resolve, reject) => { fault.holds.push(ok => ok ? resolve() : reject(new Error('Motion fixture rejected mutation'))) })
        return original(event, ...args)
      })
    }
  })
  const calls = () => app.evaluate(() => globalThis.motionFault.calls)
  const fault = (...modes) => app.evaluate((_electron, modes) => { Object.assign(globalThis.motionFault, { modes, calls: 0 }) }, modes)
  const release = (index = 0, ok = true) => app.evaluate((_electron, [index, ok]) => { globalThis.motionFault.holds.splice(index, 1)[0](ok) }, [index, ok])
  const holds = () => app.evaluate(() => globalThis.motionFault.holds.length)
  const busy = value => expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', String(value))
  const folders = name => page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.filter(f => f.name === name).length, name)
  const openForm = async text => { await click(create); await click(folder); await expect(page.locator(input)).toBeFocused(); if (text) await page.locator(input).fill(text) }
  const editing = async text => { await expect(page.locator(input)).toHaveValue(text); await expect(page.locator(input)).toBeFocused() }
  try {
    await fault('reject')
    await openForm('Rejected folder'); await page.keyboard.press('Enter'); await busy(false); expect(await calls()).toBe(1); expect(await folders('Rejected folder')).toBe(0)
    await fault('hold'); await openForm('Pending folder'); await page.keyboard.press('Enter'); await busy(true)
    await openForm('Fresh session'); await release(); await busy(false); await editing('Fresh session'); await page.keyboard.press('Escape')
    await fault('hold', 'hold'); await openForm('Concurrent one'); await page.keyboard.press('Enter'); await openForm('Concurrent two'); await page.keyboard.press('Enter')
    await openForm('Third stays open'); await expect.poll(holds).toBe(2); await busy(true)
    await release(1); await frames(); await busy(true); await editing('Third stays open')
    await release(0); await busy(false); await editing('Third stays open')
    record('reverse-order-concurrent-folder-sessions', { one: await folders('Concurrent one'), two: await folders('Concurrent two'), calls: await calls(), pass: await folders('Concurrent one') === 1 && await folders('Concurrent two') === 1 && await calls() === 2 })
    await page.keyboard.press('Escape'); await fault('hold'); await openForm('Old rejected'); await page.keyboard.press('Enter')
    await openForm('Newer form'); await release(0, false); await expect(page.locator('.toast')).toContainText('Motion fixture rejected mutation'); await busy(false); await editing('Newer form')
    record('old-rejection-after-newer-form-reports-and-keeps-editor', { rejected: await folders('Old rejected'), pass: await folders('Old rejected') === 0 })
    await page.keyboard.press('Escape'); await fault(); await openForm(); await page.keyboard.insertText(`<i>🙂 Limit</i> ${'x'.repeat(5000)}`)
    const typed = await page.locator(input).inputValue()
    await page.locator(input).evaluate(node => { for (let index = 0; index < 3; index++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); node.blur() })
    await expect(page.locator('.sidebar-folder-head span', { hasText: '<i>🙂 Limit</i>' })).toHaveCount(1); await busy(false)
    record('triple-enter-blur-one-mutation-80-character-literal-text', { length: typed.length, calls: await calls(), pass: typed.length <= 80 && typed.length > 60 && await calls() === 1 && await page.locator('.sidebar-folder-head i').count() === 0 })
    const confirmDelete = async id => { await click(`[data-testid="sidebar-chat-menu-${id}"]`); await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click() }
    await fault('reject'); await confirmDelete(bot.id); await expect(page.locator('.delete-conversation-dialog [role="alert"]')).toBeVisible()
    await page.keyboard.press('Escape'); await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0); await expect(page.locator(row(bot.id))).toBeVisible()
    await fault('hold'); await confirmDelete(d.id); await click('.delete-conversation-dialog .danger'); await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
    await expect(page.locator('.delete-conversation-dialog')).toBeVisible(); expect(await calls()).toBe(1)
    await release(); await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0); await expect(page.locator(row(d.id))).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' }); record('mutation-rejection-pending-session-held-delete-recovery')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      for (const hold of globalThis.motionFault.holds) hold(true)
      for (const [channel, original] of globalThis.motionFault.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.motionFault
    })
  }

  await mouse(row(bot.id)); await shown(bot); await session('same-row-click-discards-capture', 'no-preference', row(bot.id), `bot-${bot.id}`, null); await shown(bot)
  await openActivity(page, 'sky'); await session('non-bots-activity-skips-motion', 'no-preference', row(b.id), `bot-${b.id}`, null); await shown(b)
  for (const mode of ['absent', 'throwing', 'capture']) {
    const target = mode === 'absent' ? bot : mode === 'throwing' ? b : longA
    await page.evaluate(mode => {
      window.motionAnimate = Element.prototype.animate; window.motionClone = Node.prototype.cloneNode
      if (mode === 'capture') Node.prototype.cloneNode = function () { if (this.matches?.('.bots-thread, .comet-welcome')) throw new Error('Motion fixture capture failure'); return window.motionClone.call(this, ...arguments) }
      else Element.prototype.animate = mode === 'absent' ? undefined : () => { throw new Error('Motion fixture animate failure') }
    }, mode)
    try { await session(mode === 'capture' ? 'surface-capture-throwing-navigation-completes' : `element-animate-${mode}-navigation-completes`, 'no-preference', row(target.id), `bot-${target.id}`, null) }
    finally { await page.evaluate(() => { Element.prototype.animate = window.motionAnimate; Node.prototype.cloneNode = window.motionClone }) }
    if (mode === 'capture') await landed(target); else await shown(target)
    await usable('.bots-chat'); expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  }

  const during = []
  for (const delay of [0, 60, 120, 180, 240]) for (const second of [row(longA.id), create]) {
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
    evidence.push({ label: 'timed-trusted-double-click-long-history', delay, elapsed, targets, midMotion, snapshots, pass: clicks.length === 2 && clicks.every(one => one.trusted) && targets[0] === `bot-${longB.id}` && targets[1] === (second === create ? 'sidebar-create' : `bot-${longA.id}`) && elapsed >= delay && (elapsed > 120 || midMotion) && snapshots <= 1 })
  }
  record('second-click-landed-while-exit-snapshot-present', { pass: during.slice(0, 2).every(Boolean) })
  await settle(); await startProbe(null)
  for (const one of [longB, c, longA]) await page.mouse.click(...await center(row(one.id)))
  await page.waitForTimeout(300); const chain = await stopProbe(); await landed(longA); await usable('.bots-chat')
  record('real-b-c-a-sequence-ends-on-a', { targets: chain.clicks.map(one => one.target), residue: await residue(), pass: chain.clicks.length === 3 && chain.clicks.every(one => one.trusted) && chain.clicks.map(one => one.target).join() === [longB, c, longA].map(one => `bot-${one.id}`).join() && chain.snapshots <= 1 })

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

  await settle(); await startProbe(null); await mouse(row(longA.id))
  const started = await residue(); await page.emulateMedia({ reducedMotion: 'reduce' })
  const flipped = await (await page.waitForFunction(() => !document.querySelector('[data-chat-snapshot]') && !document.getAnimations().some(animation => animation.id.startsWith('chat-session-')) && performance.now())).jsonValue()
  const flip = { elapsed: flipped - (await stopProbe()).clicks[0].at, started }
  await landed(longA); await usable('.bots-chat')
  record('reduce-preference-mid-long-session-cancels-before-natural-end', { ...flip, pass: flip.elapsed < 150 && flip.started.snapshots === 1 && flip.started.owned === 2 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await mouse(create); await expect(page.locator(menu)).toBeVisible(); await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator(menu)).toBeHidden({ timeout: 120 }); await menuClosed(); await page.emulateMedia({ reducedMotion: 'no-preference' })
  await click(create); await click(folder); await expect(page.locator(input)).toBeFocused(); await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'reduce' }); await frames()
  await expect(page.locator(form)).toHaveCount(0); await page.emulateMedia({ reducedMotion: 'no-preference' }); record('reduce-preference-mid-menu-and-form-exit')

  for (let index = 0; index < 21; index++) await mouse(create)
  await expect(page.locator(menu)).toBeVisible(); expect(await page.locator(menu).evaluate(node => !node.inert && node.getAttribute('aria-hidden') === 'false' && document.querySelector('[data-testid="bots-new"]') === window.motionNew)).toBe(true)
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await menuClosed()
  await mouse(create); await mouse(create); await menuClosed(); await mouse(create); await expect(page.locator(menu)).toBeVisible()
  await mouse(row(b.id)); await shown(b); await menuClosed(); record('twenty-one-toggles-tab-and-outside-click-keep-destination-action')

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

  await click(`[data-testid="sidebar-chat-menu-${e.id}"]`); await expect(page.locator('.sidebar-organize-menu')).toBeVisible(); await page.evaluate(id => window.engram.botDelete(id), e.id)
  await expect(page.locator('.sidebar-organize-menu')).toHaveCount(0); await expect(page.locator(row(e.id))).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Search conversations' })
  for (let index = 0; index < 16; index++) await search.fill(index % 2 ? '' : 'No matching fixture')
  await settle(); expect(await page.evaluate(ids => ids.every(id => document.querySelectorAll(`[data-testid="bot-${id}"]`).length === 1) && !document.querySelector('[data-motion-row][aria-hidden="true"]'), [bot.id, b.id, c.id])).toBe(true)
  record('open-menu-row-removed-and-sixteen-search-reversals-leave-no-ghosts')
  const total = await page.evaluate(async () => { for (let index = 0; index < 300; index++) await window.engram.botCreate({ name: `Bulk ${index}` }); return (await window.engram.botsList()).length })
  await expect(page.locator('[data-testid="sidebar-chats"] .bots-row')).toHaveCount(total, { timeout: 10_000 })
  await search.fill('Bulk 29'); await expect(page.locator('[data-testid="sidebar-chats"] li[data-motion-state="live"]')).toHaveCount(11)
  await search.fill(''); await settle(); await expect(page.locator('[data-testid="sidebar-chats"] li')).toHaveCount(total); record('three-hundred-row-filter-round-trip', { total })

  await openActivity(page, 'routines'); await expect(page.locator(fresh)).toHaveCount(0)
  await openActivity(page, 'bots'); await expect(page.locator(fresh)).toHaveCount(1)
  record('routine-mode-keeps-new-chat-absent')
  await mouse(row(bot.id)); await shown(bot); await settle()
  for (const open of ['form', 'menu', 'session']) {
    if (open === 'session') await mouse(row(longB.id))
    else { await click(create); if (open === 'form') { await click(folder); await page.locator(input).fill('Unsaved reload') } }
    await page.reload(); await expect(page.locator(row(bot.id))).toBeVisible(); await rememberNew(); await menuClosed()
    await expect(page.locator(`${form}, [data-chat-snapshot]`)).toHaveCount(0)
  }
  expect(await folders('Unsaved reload')).toBe(0)
  for (let index = 0; index < 2; index++) { await openActivity(page, 'sky'); await openActivity(page, 'bots') }
  await mouse(row(longA.id)); await landed(longA); await usable('.bots-chat'); await settle(); expect(await residue()).toEqual({ snapshots: 0, owned: 0 })
  record('reload-with-open-form-menu-and-session-exit-then-activity-round-trips', { errors })
  return { ok: evidence.every(record => record.pass) && !errors.length, evidence }
  } catch (error) { return { ok: false, evidence: [...evidence, { error: error.stack }] } }
}
