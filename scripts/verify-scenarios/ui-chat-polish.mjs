/* global document, getComputedStyle, innerWidth, innerHeight, window */
import { appendBotTurn, createBot } from '../../packages/core/src/index.ts'

const sizes = [{ width: 1280, height: 840 }, { width: 620, height: 640 }]

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
    await folder.getByTestId(`bot-${fixtures[0].id}`).click()
    await expect(page.locator('.conversation-title')).toHaveText(fixtures[0].name)
    await expect(page.locator('.bots-thread .bubble-msg.user')).toHaveText('Please review this.')
    await expect(page.locator('.bots-thread .bubble-msg.assistant')).toContainText(fixtures[0].preview)
    await page.getByTestId('bots-input').fill('A draft to check composer bounds.\nA second line.')
    const result = await assertChatLayout(page, expect)
    evidence.push({ ...result, sidebar: 'two independent folders and unfiled avatar/preview rows' })
    log.write(`[ui-chat-polish] ${JSON.stringify(evidence.at(-1))}\n`)
  }
  return { ok: evidence.every(result => result.errors.length === 0), evidence }
}
