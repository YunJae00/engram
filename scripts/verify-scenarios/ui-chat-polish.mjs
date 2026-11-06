/* global document, getComputedStyle, innerWidth, innerHeight, window */
import { appendBotTurn, createBot, renameBot } from '../../packages/core/src/index.ts'

const sizes = [{ width: 1280, height: 840 }, { width: 620, height: 640 }]
const sidebarChecks = [['.sidebar-item:not(.active) .sidebar-conversation-name', '.app-sidebar'], ['.sidebar-work-status > span:last-child', '.app-sidebar']]
const memoryChecks = [['.bots-memory-title', '.bots-memory'], ['.bots-memory-empty', '.bots-memory']]

class FocusLost extends Error {}

export async function assertChatLayout(page, expect) {
  const thread = page.getByTestId('bots-thread')
  const user = thread.locator('.bubble-msg.user')
  const assistant = thread.locator('.bubble-msg.assistant')
  const title = page.locator('.conversation-title')
  const composer = page.locator('.bots-write .chat-write')
  for (const locator of [thread, user, assistant, title, composer]) await expect(locator).toBeVisible()
  return page.evaluate(() => {
    const errors = []
    const check = (condition, label) => { if (!condition) errors.push(label) }
    const node = selector => document.querySelector(selector)
    const box = selector => node(selector).getBoundingClientRect()
    const inside = (child, parent) => child.left >= parent.left - 1 && child.right <= parent.right + 1 && child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1
    const rounded = selector => parseFloat(getComputedStyle(node(selector)).borderTopLeftRadius) > 0
    const chat = box('.bots-chat')
    const thread = box('.bots-thread')
    const user = box('.bots-thread .bubble-msg.user')
    const assistant = box('.bots-thread .bubble-msg.assistant')
    const title = box('.conversation-title')
    const composer = box('.bots-write .chat-write')
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    check(inside(user, thread) && inside(assistant, thread), 'bubbles stay inside the thread')
    check(user.left > assistant.left && user.right > assistant.right, 'user bubble is right of assistant bubble')
    for (const role of ['user', 'assistant']) {
      const selector = `.bots-thread .bubble-msg.${role}`
      check(rounded(selector), `${role} bubble is rounded`)
      check(getComputedStyle(node(selector)).backgroundColor !== 'rgba(0, 0, 0, 0)', `${role} bubble has a surface`)
    }
    check(Math.abs(title.left + title.width / 2 - (chat.left + chat.width / 2)) <= 3, 'title is centered over chat')
    check(rounded('.conversation-title'), 'title is a rounded pill')
    check(inside(title, viewport), 'title stays in viewport')
    check(inside(composer, chat) && inside(composer, viewport), 'composer stays inside chat and viewport')
    check(composer.top >= thread.bottom - 1, 'composer does not overlap the thread')
    check(rounded('.bots-write .chat-write'), 'composer is rounded')
    check(inside(box('[data-testid="bots-input"]'), composer), 'input stays inside composer')
    check(document.documentElement.scrollWidth <= innerWidth, 'page has no horizontal overflow')
    return { width: innerWidth, height: innerHeight, errors }
  })
}

export async function run(page, { app, paths, expect, openActivity, log }) {
  const rendererErrors = []
  page.on('pageerror', error => rendererErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()) })
  const originalTheme = await page.locator('html').getAttribute('data-theme')
  const fixtures = []
  for (const [name, preview] of [['Release review', 'Ready for review.'], ['Design notes', 'The layout is clear.'], ['Unfiled chat', 'Saved for later.']]) {
    const bot = await createBot(paths, { name })
    await appendBotTurn(paths, bot.id, { role: 'user', text: 'Please review this.', at: new Date().toISOString() })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: preview, at: new Date().toISOString() })
    fixtures.push({ ...bot, preview })
  }
  const folders = await page.evaluate(async ids => {
    const folders = []
    for (const [index, name] of ['Work', 'Personal'].entries()) {
      const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name } })
      const folder = layout.chat.folders.find(folder => folder.name === name)
      await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: ids[index], folder: folder.id } })
      folders.push(folder.id)
    }
    return folders
  }, fixtures.map(bot => bot.id))
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'bots:changed' })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const evidence = []
  const ctx = { page, app, expect, log }
  try {
    ctx.target = await app.browserWindow(page)
    ctx.guard = await ctx.target.evaluateHandle(window => {
      const guard = {
        window,
        blurGeneration: 0,
        onBlur: () => { guard.blurGeneration += 1 },
        state: () => ({ focused: window.isFocused() && window.isVisible() && !window.isMinimized(), visible: window.isVisible(), minimized: window.isMinimized(), generation: guard.blurGeneration }),
      }
      window.on('blur', guard.onBlur)
      return guard
    })
    // A hidden launch leaves macOS treating the test process as a background app that cannot take focus.
    await app.evaluate(async ({ app }) => {
      if (process.platform !== 'darwin') return
      app.setActivationPolicy('regular')
      await app.dock.show()
      app.show()
    })
    // A window that is never shown yields no frames on X11, so every screenshot below needs a focused window first.
    await acquireFocus(ctx, 'launch')
    for (const size of sizes) {
      await page.setViewportSize(size)
      await openActivity(page, 'bots')
      const sidebar = page.getByTestId('app-sidebar')
      if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
      for (const [index, bot] of fixtures.entries()) {
        const group = index < 2 ? page.getByTestId(`sidebar-folder-${folders[index]}`) : page.getByTestId('sidebar-chats')
        const row = group.getByTestId(`bot-${bot.id}`)
        await expect(row).toBeVisible()
        await expect(row.locator('.sidebar-conversation-name')).toHaveText(bot.name)
        await expect(row.locator('.sidebar-conversation-preview')).toHaveText(bot.preview)
        await expect(row.locator('.sidebar-conversation-avatar')).toBeVisible()
        await expect.poll(() => row.evaluate(row => {
          const box = row.getBoundingClientRect()
          const avatar = row.querySelector('.sidebar-conversation-avatar').getBoundingClientRect()
          const name = row.querySelector('.sidebar-conversation-name').getBoundingClientRect()
          const preview = row.querySelector('.sidebar-conversation-preview').getBoundingClientRect()
          return avatar.width > 0 && avatar.right <= name.left + 1 && name.bottom <= preview.top + 1 && preview.right <= box.right + 1 && box.left >= 0 && box.right <= innerWidth
        })).toBe(true)
      }
      const folder = page.getByTestId(`sidebar-folder-${folders[0]}`)
      const toggle = folder.locator('.sidebar-folder-head > button.sidebar-item-main')
      await toggle.click()
      await expect(folder.getByTestId(`bot-${fixtures[0].id}`)).toBeHidden()
      await expect(page.getByTestId(`bot-${fixtures[1].id}`)).toBeVisible()
      await toggle.click()
      await page.screenshot({ path: `tmp/verify-cli/ui-chat-polish-${size.width}-sidebar.png` })
      await folder.getByTestId(`bot-${fixtures[0].id}`).click()
      await expect(page.locator('.conversation-title')).toHaveText(fixtures[0].name)
      await expect(page.locator('.bots-thread .bubble-msg.user')).toHaveText('Please review this.')
      await expect(page.locator('.bots-thread .bubble-msg.assistant')).toContainText(fixtures[0].preview)
      if (size.width <= 900 && await sidebar.getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
      await page.getByTestId('bots-input').fill('A draft to check composer bounds.\nA second line.')
      await expect.poll(async () => (await assertChatLayout(page, expect)).errors).toEqual([])
      const result = await assertChatLayout(page, expect)
      evidence.push({ ...result, sidebar: 'two independent folders and unfiled avatar/preview rows' })
      log.write(`[ui-chat-polish] ${JSON.stringify(evidence.at(-1))}\n`)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
        await acquireFocus(ctx, `${size.width} ${theme}`)
        await expect.poll(() => presentation(page)).toEqual([])
        if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
        evidence.push({ width: size.width, theme, state: 'focused sidebar', contrast: await readableContrast(ctx, sidebarChecks), errors: [] })
        if (size.width <= 900) await page.getByTestId('app-sidebar-close').click()
        evidence.push({ width: size.width, theme, errors: await presentation(page) })
        const input = page.getByTestId('bots-input')
        await expect(input).toHaveAttribute('placeholder', /.+/)
        await page.getByTestId('bots-input-add').focus()
        await page.keyboard.press('Enter')
        const menu = page.locator('.bots-main .chat-add-menu:popover-open')
        await expect(menu).toBeVisible()
        for (const selector of ['.chat-attach-button', '[data-testid="bots-memory-toggle"]', '[data-testid="computer-controls-open"]', '.composer-web']) {
          await expect(menu.locator(selector).first()).toBeVisible()
        }
        await expect.poll(() => withinViewport(menu)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        await page.getByTestId('bots-input-add').click()
        await page.getByTestId('bots-memory-toggle').click()
        await expect(page.getByTestId('bots-memory')).toBeVisible()
        evidence.push({ width: size.width, theme, state: 'composer memory', contrast: await readableContrast(ctx, memoryChecks), errors: [] })
        await page.screenshot({ path: `tmp/verify-cli/ui-chat-polish-${size.width}-${theme}-memory.png` })
        await page.getByTestId('bots-input-add').click()
        await page.getByTestId('bots-memory-toggle').click()
        await expect(page.getByTestId('bots-memory')).toBeHidden()
        await page.locator('.bots-write [data-testid="model-picker"]').click()
        const models = page.getByTestId('model-picker-menu')
        await expect(models).toBeVisible()
        await expect.poll(() => withinViewport(models)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(models).toBeHidden()
        await page.screenshot({ path: `tmp/verify-cli/ui-chat-polish-${size.width}-${theme}.png` })
      }
      const input = page.getByTestId('bots-input')
      await input.fill(('line of draft\n'.repeat(160)).slice(0, 2000))
      await expect(input).toHaveAttribute('maxlength', '2000')
      expect((await input.inputValue()).length).toBe(2000)
      expect(await input.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight <= 180)).toBe(true)
      await page.getByTestId('bots-input-files').setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') })
      await expect(page.locator('.bots-write [role="alert"]')).toBeVisible()
      await expect(page.getByTestId('bots-input-send')).toBeEnabled()
      expect(await composerBounds(page)).toEqual([])
      await selectBot(page, expect, fixtures[1])
      await expect(page.locator('.bots-write [role="alert"]')).toHaveCount(0)
      await selectBot(page, expect, fixtures[0])
      expect((await input.inputValue()).length).toBe(2000)
      await input.fill('A draft to check composer bounds.\nA second line.')
    }
    await acquireFocus(ctx, 'focus guard self-check start')
    const saved = await nativeState(ctx.guard)
    await ctx.guard.evaluate(({ window }) => window.hide())
    await expect.poll(async () => (await nativeState(ctx.guard)).focused, { message: 'hidden test window loses native focus' }).toBe(false)
    await acquireFocus(ctx, 'focus guard self-check refocus')
    const refocused = await nativeState(ctx.guard)
    expect(refocused.generation).toBeGreaterThan(saved.generation)
    expect(() => requireFocus(refocused, saved.generation, 'across hide and refocus')).toThrow(FocusLost)
    evidence.push({ state: 'focus guard self-check', generations: [saved.generation, refocused.generation], contrast: await sidebarContrast(ctx), errors: [] })
    const longName = ('Release review ' + 'longname'.repeat(20)).slice(0, 60)
    await renameBot(paths, fixtures[0].id, longName)
    fixtures[0].name = longName
    await appendBotTurn(paths, fixtures[0].id, { role: 'assistant', text: 'x'.repeat(600) + '\n\n```text\n' + 'code'.repeat(300) + '\n```', at: new Date().toISOString() })
    await page.reload()
    await openActivity(page, 'bots')
    for (const size of [sizes[0], sizes[1], sizes[0]]) {
      await page.setViewportSize(size)
      await selectBot(page, expect, fixtures[1])
      await selectBot(page, expect, fixtures[0])
      await expect(page.locator('.bots-thread pre')).toBeVisible()
      const errors = await page.evaluate(() => {
        const errors = []
        for (const bubble of document.querySelectorAll('.bots-thread .bubble-msg')) {
          const box = bubble.getBoundingClientRect()
          if (box.left < 0 || box.right > innerWidth) errors.push('long bubble exceeds viewport')
        }
        for (const selector of ['.chat-title-pill .bots-head-name', '.sidebar-item.active .sidebar-conversation-name']) {
          const style = getComputedStyle(document.querySelector(selector))
          if (style.textOverflow !== 'ellipsis') errors.push('long title missing ellipsis')
        }
        if (document.documentElement.scrollWidth > innerWidth) errors.push('long content overflows document')
        return errors
      })
      evidence.push({ width: size.width, state: 'long content after reload and bot switch', errors })
      await page.getByTestId('app-sidebar-open').click()
      for (const id of folders) await expect(page.getByTestId(`sidebar-folder-${id}`)).toBeVisible()
      await expect(page.getByTestId(`bot-${fixtures[1].id}`).locator('.sidebar-conversation-preview')).toHaveText(fixtures[1].preview)
      await page.getByTestId('app-sidebar-close').click()
      await expect.poll(() => titleAndComposer(page)).toEqual([])
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await acquireFocus(ctx, 'dark after reload')
    const reloaded = await sidebarContrast(ctx)
    await page.getByTestId('bots-input-add').click()
    await page.getByTestId('bots-memory-toggle').click()
    await expect(page.getByTestId('bots-memory')).toBeVisible()
    reloaded.push(...await readableContrast(ctx, memoryChecks))
    await page.getByTestId('bots-input-add').click()
    await page.getByTestId('bots-memory-toggle').click()
    await expect(page.getByTestId('bots-memory')).toBeHidden()
    evidence.push({ width: sizes[0].width, theme: 'dark', state: 'focused sidebar and composer memory after reload', contrast: reloaded, errors: [] })
    evidence.push({ state: 'renderer errors', errors: rendererErrors })
    return { ok: evidence.every(result => result.errors.length === 0), evidence }
  } finally {
    const cleanup = [
      () => page.isClosed() ? undefined : page.evaluate(theme => { if (theme === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme) }, originalTheme),
      () => ctx.guard?.evaluate(({ window, onBlur }) => { if (!window.isDestroyed()) window.removeListener('blur', onBlur) }),
      () => Promise.all([ctx.guard?.dispose(), ctx.target?.dispose()]),
    ]
    // Cleanup failures are logged, not thrown, so they cannot replace the scenario's own error.
    for (const step of cleanup) await Promise.resolve().then(step).catch(error => log.write(`[ui-chat-polish] cleanup: ${error.message}\n`))
  }
}

const nativeState = guard => guard.evaluate(guard => guard.state())
const rendererFocused = async page => await page.locator('html').getAttribute('data-window-focused') === 'true'

function requireFocus(state, generation, when) {
  if (!state.focused || state.generation !== generation) throw new FocusLost(`native focus lost ${when}: ${JSON.stringify({ ...state, expected: generation })}`)
}

async function acquireFocus({ page, app, expect, log, guard }, label) {
  const activate = () => app.evaluate(({ app }, { window }) => {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    app.focus({ steal: true })
    window.moveTop()
    window.focus()
    return window.isFocused() && window.isVisible() && !window.isMinimized()
  }, guard)
  await activate()
  await page.bringToFront()
  await expect.poll(activate, { message: 'native Electron window is focused', timeout: 10000 }).toBe(true).catch(async error => {
    log.write(`[ui-chat-polish] focus refused at ${label}: ${JSON.stringify(await nativeState(guard))}\n`)
    throw error
  })
  await expect(page.locator('html')).toHaveAttribute('data-window-focused', 'true')
}

async function readableContrast(ctx, checks) {
  let contrast
  await ctx.expect.poll(async () => {
    contrast = await renderedContrast(ctx, checks).catch(error => {
      if (!(error instanceof FocusLost)) throw error
      ctx.log.write(`[ui-chat-polish] discarded sample: ${error.message}\n`)
    })
    if (!contrast) await acquireFocus(ctx, 'contrast resample')
    return Boolean(contrast?.every(check => check.ratio >= 4.5))
  }, { message: 'focused rendered contrast is at least 4.5' }).toBe(true)
  return contrast
}

async function sidebarContrast(ctx) {
  const hidden = await ctx.page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true'
  if (hidden) await ctx.page.getByTestId('app-sidebar-open').click()
  const contrast = await readableContrast(ctx, sidebarChecks)
  if (hidden) await ctx.page.getByTestId('app-sidebar-close').click()
  return contrast
}

async function withinViewport(locator) {
  return locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  })
}

async function selectBot(page, expect, bot) {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${bot.id}`).click()
  await expect(page.locator('.conversation-title')).toHaveText(bot.name)
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
  await expect.poll(() => titleAndComposer(page)).toEqual([])
}

async function titleAndComposer(page) {
  const errors = await composerBounds(page)
  return page.evaluate(errors => {
    const title = document.querySelector('.conversation-title').getBoundingClientRect()
    const chat = document.querySelector('.bots-chat').getBoundingClientRect()
    if (Math.abs(title.left + title.width / 2 - chat.left - chat.width / 2) > 3) errors.push('title not centered after transition')
    for (const control of document.querySelectorAll('.topbar button')) {
      const box = control.getBoundingClientRect()
      if (box.width && title.left < box.right && title.right > box.left && title.top < box.bottom && title.bottom > box.top) errors.push('title covers toolbar control')
    }
    return errors
  }, errors)
}

async function composerBounds(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('.bots-write .chat-write')
    const bounds = composer.getBoundingClientRect()
    const errors = []
    for (const element of composer.querySelectorAll('textarea, .chat-file-list, [role="alert"], .chat-write-footer, .chat-add-button')) {
      const box = element.getBoundingClientRect()
      if (box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom) errors.push('composer child exceeds bounds')
    }
    if (bounds.left < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight) errors.push('composer exceeds viewport')
    return errors
  })
}

async function presentation(page) {
  return page.evaluate(() => {
    const errors = []
    const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor
    for (const [selector, expected] of [
      ['.app-sidebar', 'rgb(245, 245, 245)'], ['.bots-main', 'rgb(252, 252, 253)'],
      ['.bots-write .chat-write', 'rgb(255, 255, 255)'], ['.sidebar-item.active', 'rgb(230, 230, 230)'],
      ['.bots-thread .bubble-msg.assistant', 'rgb(239, 239, 239)'], ['.bots-thread .bubble-msg.user', 'rgb(50, 118, 220)'],
    ]) if (color(selector) !== expected) errors.push(`${selector} has wrong local color`)
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    const input = box('[data-testid="bots-input"]')
    const plus = box('[data-testid="bots-input-add"]')
    const send = box('[data-testid="bots-input-send"]')
    if (input.bottom > plus.top || input.bottom > send.top) errors.push('textarea not above controls')
    if (Math.abs(send.width - send.height) > 1 || parseFloat(getComputedStyle(document.querySelector('[data-testid="bots-input-send"]')).borderRadius) < 16) errors.push('send not round')
    return errors
  })
}

async function renderedContrast({ page, expect, guard }, checks) {
  for (const [selector] of checks) await expect(page.locator(selector).first()).toBeVisible()
  const start = await nativeState(guard)
  requireFocus(start, start.generation, 'before sampling')
  if (!await rendererFocused(page)) throw new FocusLost('renderer focus lost before sampling')
  const samples = await page.evaluate(checks => checks.map(([selector, surface]) => {
    const node = document.querySelector(selector)
    const text = node.getBoundingClientRect()
    const box = document.querySelector(surface).getBoundingClientRect()
    return { selector, foreground: getComputedStyle(node).color.match(/[\d.]+/g).slice(0, 3).map(Number), x: Math.floor(box.left + 8), y: Math.floor(text.top + text.height / 2) }
  }), checks)
  const { before, after, backgrounds } = await guard.evaluate(async (guard, { samples, width }) => {
    const before = guard.state()
    const capture = await guard.window.webContents.capturePage()
    const after = guard.state()
    const image = capture.resize({ width })
    const size = image.getSize()
    const bitmap = image.toBitmap()
    return { before, after, backgrounds: samples.map(({ x, y }) => {
      if (!(x >= 0 && x < size.width && y >= 0 && y < size.height)) return null
      const offset = (y * size.width + x) * 4
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
    }) }
  }, { samples, width: (await page.viewportSize()).width })
  requireFocus(before, start.generation, 'before capture')
  requireFocus(after, start.generation, 'after capture')
  if (!await rendererFocused(page)) throw new FocusLost('renderer focus lost after capture')
  const end = await nativeState(guard)
  requireFocus(end, start.generation, 'after sampling')
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  return samples.map(({ selector, foreground }, index) => {
    const background = backgrounds[index] ?? [NaN, NaN, NaN]
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    const ratio = (values[0] + 0.05) / (values[1] + 0.05)
    if (foreground.length !== 3 || ![...foreground, ...background, ratio].every(Number.isFinite)) throw new Error(`contrast sample for ${selector} is not a finite in-bounds pixel: ${JSON.stringify({ foreground, background })}`)
    return { selector, foreground, background, ratio, generation: end.generation, nativeFocused: end.focused }
  })
}
