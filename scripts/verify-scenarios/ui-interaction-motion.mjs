/* global window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle */
export async function run(page, { expect, openActivity, app }) {
  const evidence = [], errors = []
  try {
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await openActivity(page, 'bots')
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Motion fixture' }))
  await expect(page.getByTestId(`bot-${bot.id}`)).toBeVisible()
  const create = '[data-testid="sidebar-create"]'
  const folder = '[aria-label="New chat folder"]'
  const form = '.sidebar-folder-create'
  const menu = '.sidebar-create-menu'
  const input = '[aria-label="Folder name"]'
  const click = selector => page.evaluate(selector => document.querySelector(selector).click(), selector)
  const settle = () => page.waitForFunction(() => !document.documentElement.hasAttribute('data-chat-motion') && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity), undefined, { timeout: 1000 })
  async function measure(target, direction, preference, action, pseudo = '', property = 'opacity', persistent = false) {
    await settle()
    await page.evaluate(({ target, pseudo, property }) => {
      window.motionProbe = { found: [], stopped: false, target, pseudo }
      const scan = () => {
        const probe = window.motionProbe
        if (probe.stopped) return
        const node = document.querySelector(target)
        const animations = pseudo ? document.getAnimations().filter(a => a.effect?.pseudoElement === pseudo) : node?.getAnimations() ?? []
        for (const animation of animations) {
          if (probe.found.some(record => record.animation === animation)) continue
          const effect = animation.effect, timing = effect.getTiming()
          if (!pseudo && animation.transitionProperty !== property) continue
          animation.pause()
          const samples = [0, .25, .75, 1].map(fraction => {
            animation.currentTime = Number(timing.duration) * fraction
            const style = getComputedStyle(effect.target, pseudo || null)
            return { value: property === 'grid-template-rows' ? parseFloat(style.height) : Number(style.opacity), progress: effect.getComputedTiming().progress }
          })
          probe.found.push({ animation, duration: timing.duration, easing: timing.easing === 'linear' ? effect.getKeyframes()[0]?.easing : timing.easing, samples })
          animation.currentTime = 0; animation.play()
        }
        probe.frame = requestAnimationFrame(scan)
      }
      scan()
    }, { target, pseudo, property })
    await action()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (preference === 'no-preference') await page.waitForFunction(() => window.motionProbe.found.length > 0, undefined, { timeout: 800 }).catch(() => {})
    const measurements = await page.evaluate(() => {
      const probe = window.motionProbe
      probe.stopped = true; cancelAnimationFrame(probe.frame)
      return probe.found.map(({ duration, easing, samples }) => ({ duration, easing, samples }))
    })
    const retained = preference === 'reduce' && direction === 'exit' && !pseudo && !persistent ? await page.locator(target).count() : 0
    const pass = preference === 'reduce' ? !retained && measurements.every(m => m.duration <= 1) : measurements.some(m => {
      const [start, quarter, later, end] = m.samples.map(s => s.value)
      const range = end - start
      return m.duration >= 120 && m.duration <= 260 && m.easing !== 'linear' && Math.abs(range) > .5 && Math.abs((quarter - start) / range - .25) > .05 && quarter !== later
    })
    evidence.push({ target: pseudo || target, direction, preference, measurements, retained, pass })
    await settle()
    if (direction === 'exit' && !pseudo && !persistent) await expect(page.locator(target)).toHaveCount(0, { timeout: 1000 })
  }
  for (const preference of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: preference })
    await measure(menu, 'entry', preference, () => click(create))
    await measure(menu, 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.getByTestId('sidebar-create')).toBeFocused()
    await click(create)
    await settle()
    await page.getByTestId('topbar').click({ position: { x: 5, y: 5 } })
    await expect(page.locator(menu)).toHaveCount(0)
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
    evidence.push({ label: 'escape-outside-focus-single-submit-reopen', preference, pass: true })

    const search = page.getByRole('textbox', { name: 'Search conversations' })
    const row = `li:has([data-testid="bot-${bot.id}"])`
    await measure(row, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(row, 'entry', preference, () => search.fill(''))
    const folderId = await page.evaluate(async name => (await window.engram.sidebarLayout('chat')).chat.folders.find(f => f.name === name).id, `Measured folder ${preference}`)
    const folderRow = `[data-testid="sidebar-folder-${folderId}"]`
    await measure(folderRow, 'exit', preference, () => search.fill('No matching fixture'))
    await measure(folderRow, 'entry', preference, () => search.fill(''))
    await click(`[data-testid="bot-${bot.id}"]`); await expect(page.getByTestId('bots-thread')).toBeVisible(); await settle()
    await click(create); await settle()
    await measure('.comet-welcome', 'entry', preference, () => click('[data-testid="bots-new"]'), '::view-transition-new(chat-surface)')
    await expect(page.locator('.comet-welcome')).toBeVisible()
    await measure('.comet-welcome', 'exit', preference, () => click(`[data-testid="bot-${bot.id}"]`), '::view-transition-old(chat-surface)')
    await expect(page.getByTestId('bots-thread')).toBeVisible()

    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await measure('.delete-conversation-dialog', 'entry', preference, () => page.getByRole('button', { name: 'Delete', exact: true }).click())
    await page.mouse.click(5, 5)
    await expect(page.locator('.delete-conversation-dialog')).toBeVisible()
    await measure('.delete-conversation-dialog', 'exit', preference, () => page.keyboard.press('Escape'))
    await expect(page.getByTestId(`bot-${bot.id}`)).toBeVisible()
    evidence.push({ label: 'delete-backdrop-blocks-escape-closes', preference, pass: true })
    await page.evaluate(({ id, folder }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } }), { id: bot.id, folder: folderId })
    await page.reload(); await expect(page.getByTestId(`bot-${bot.id}`)).toBeVisible()
    const disclosure = `#folder-${folderId}`, toggle = `[aria-controls="folder-${folderId}"]`
    await measure(disclosure, 'exit', preference, () => click(toggle), '', 'grid-template-rows', true)
    await expect(page.locator(disclosure)).toHaveAttribute('aria-hidden', 'true')
    await measure(disclosure, 'entry', preference, () => click(toggle), '', 'grid-template-rows', true)
    await expect(page.locator(disclosure)).toHaveAttribute('data-settled', 'true')
    expect(await page.locator(disclosure).evaluate(node => node.firstElementChild.inert)).toBe(false)
    await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: null } }), bot.id)
    await page.reload(); await expect(page.getByTestId(`bot-${bot.id}`)).toBeVisible()

  }
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
  try {
    await app.evaluate(() => { globalThis.motionFault.mode = 'reject' })
    await click(create); await click(folder)
    await page.locator(input).fill('Rejected folder'); await page.keyboard.press('Enter')
    await expect(page.getByTestId('sidebar-chat-collection')).toHaveAttribute('aria-busy', 'false')
    expect(await app.evaluate(() => globalThis.motionFault.calls)).toBe(1)
    expect(await page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.folders.some(f => f.name === 'Rejected folder'))).toBe(false)
    await app.evaluate(() => { globalThis.motionFault.mode = 'hold' })
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
    await app.evaluate(() => { globalThis.motionFault.mode = 'reject' })
    await click(`[data-testid="sidebar-chat-menu-${bot.id}"]`)
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await expect(page.locator('.delete-conversation-dialog [role="alert"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.delete-conversation-dialog')).toHaveCount(0)
    await expect(page.getByTestId(`bot-${bot.id}`)).toBeVisible()
    evidence.push({ label: 'mutation-rejection-pending-session-delete-recovery', pass: true })
  } finally {
    await app.evaluate(({ ipcMain }) => {
      globalThis.motionFault.release?.()
      for (const [channel, original] of globalThis.motionFault.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.motionFault
    })
  }
  await click(create); await settle()
  await page.evaluate(() => {
    const original = document.startViewTransition
    try { document.startViewTransition = undefined; document.querySelector('[data-testid="bots-new"]').click() }
    finally { document.startViewTransition = original }
  })
  await expect(page.locator('.comet-welcome')).toBeVisible()
  await page.locator('.comet-welcome textarea').fill('Ready after navigation')
  await page.locator('.comet-welcome textarea').fill('')
  evidence.push({ label: 'missing-view-transition-api-controls-usable', pass: true })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (let index = 0; index < 3; index++) {
    await click(`[data-testid="bot-${bot.id}"]`)
    await expect(page.getByTestId('bots-thread')).toBeVisible()
    await click(create)
    await click('[data-testid="bots-new"]')
    await expect(page.locator('.comet-welcome')).toBeVisible()
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await settle()
  await page.locator('.comet-welcome textarea').fill('Rapid navigation settled')
  await page.locator('.comet-welcome textarea').fill('')
  evidence.push({ label: 'rapid-navigation-preference-reversal', pass: true })

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await click(create); await click(folder)
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.locator(form)).toHaveCount(0)
  await openActivity(page, 'sky'); await openActivity(page, 'bots')
  await click(create); await click(folder)
  await page.locator(input).fill('Reload fixture')
  await page.keyboard.press('Enter')
  await settle()
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.locator(form)).toHaveCount(0)
  await expect(page.locator(menu)).toHaveCount(0)
  evidence.push({ label: 'preference-unmount-reload', pass: true, errors })
  return { ok: evidence.every(record => record.pass) && !errors.length, evidence }
  } catch (error) { return { ok: false, evidence: [...evidence, { error: error.stack }] } }
}
