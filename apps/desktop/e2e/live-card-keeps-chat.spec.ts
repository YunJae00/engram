import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const TURNS = 30

test('a live card leaves earlier messages readable', async () => {
  const vault = await mkdtemp(join(TMP, 'live-card-chat-'))
  const userData = await mkdtemp(join(TMP, 'live-card-user-'))
  let app: ElectronApplication | undefined
  try {
    const paths = await initVault(vault, { git: false })
    let bot: Awaited<ReturnType<typeof createBot>> | undefined
    // Card state lives in the renderer, so each theme gets a fresh launch that starts with no card.
    for (const theme of ['light', 'dark']) {
      app = await electron.launch({
        args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
        env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
      })
      const page = await app.firstWindow()
      await expect(page.getByTestId('shell')).toBeVisible()
      // First launch settles its own starter bots, so the seeded chat is written after it.
      if (!bot) {
        bot = await createBot(paths, { name: 'Live card' })
        for (let index = 1; index <= TURNS; index++) {
          const role = index % 2 ? 'user' : 'assistant'
          await appendBotTurn(paths, bot.id, { role, text: `turn ${index} ${role === 'user' ? 'asks about the report' : 'answers with the next detail of the report'}`, at: new Date(Date.now() + index).toISOString() })
        }
      }
      const { id } = bot
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800])
      const size = { width: 1280, height: 720 }
      const data = await app.evaluate(({ nativeImage }, size) => nativeImage.createFromBuffer(Buffer.alloc(size.width * size.height * 4, 0x80), size).toPNG().toString('base64'), size)
      await openActivity(page, 'bots')
      const chatGeometry = () => page.evaluate(() => {
        const box = (selector: string) => { const rect = document.querySelector(selector)!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height } }
        return { chat: box('.bots-chat'), thread: box('.bots-thread') }
      })
      await page.getByTestId(`bot-${id}`).click()
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
      const card = page.locator('.bots-chat').getByTestId('preview-card')
      await expect(page.locator('.bots-thread')).toContainText(`turn ${TURNS} `)
      await expect(card).toHaveCount(0)
      const bare = await chatGeometry()
      expect(bare.thread.top - bare.chat.top, `${theme}: no empty band above the thread`).toBeLessThanOrEqual(60)

      const lane = `bot-${id}`
      await app.evaluate(({ BrowserWindow }, events) => {
        const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
        for (const event of events) window.webContents.send('engram:event', event)
      }, [{ type: 'comet:working', channel: lane, working: true }, { type: 'comet:step', channel: lane, line: 'read_open_page: Live card' }, { type: 'agent:live', on: true, url: 'https://example.test/live', lane }, { type: 'agent:frame', lane, url: 'https://example.test/live', data, ...size }])
      await expect(card).toBeVisible()
      await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })

      await expect.poll(async () => {
        const live = await chatGeometry()
        return [Math.abs(live.thread.top - bare.thread.top) <= 4, live.thread.height >= bare.thread.height - 4]
      }, `${theme}: the thread keeps its place and height beside the card`).toEqual([true, true])
      const cardBox = (await card.boundingBox())!
      const { chat } = await chatGeometry()
      expect(cardBox.y - chat.top, `${theme}: card at the chat top`).toBeLessThanOrEqual(40)
      expect(chat.right - (cardBox.x + cardBox.width), `${theme}: card at the chat right`).toBeLessThanOrEqual(40)

      const band = { top: cardBox.y, bottom: cardBox.y + cardBox.height / 2, left: cardBox.x }
      await expect.poll(() => page.evaluate(band => {
        const thread = document.querySelector('.bots-thread')!.getBoundingClientRect()
        return [...document.querySelectorAll('.bots-thread .bubble-msg')].some(node => {
          const box = node.getBoundingClientRect()
          const top = Math.max(box.top, band.top, thread.top), bottom = Math.min(box.bottom, band.bottom, thread.bottom)
          const right = Math.min(box.right, band.left)
          if (bottom <= top || right <= box.left) return false
          return node.contains(document.elementFromPoint((box.left + right) / 2, (top + bottom) / 2))
        })
      }, band), `${theme}: a message is readable left of the card's top half`).toBe(true)

      const thread = page.locator('.bots-thread')
      await thread.evaluate(node => { node.scrollTop = 0 })
      await expect.poll(() => thread.evaluate((node, text) => {
        const view = node.getBoundingClientRect()
        const first = [...node.querySelectorAll('.bubble-msg')].find(one => one.textContent?.includes(text))
        if (!first) return false
        const box = first.getBoundingClientRect()
        return box.bottom > view.top && box.top < view.bottom
      }, 'turn 1 '), `${theme}: scrolling up reveals the first message`).toBe(true)
      await thread.evaluate(node => { node.scrollTop = node.scrollHeight })
      await expect.poll(() => thread.evaluate(node => node.scrollTop), `${theme}: the thread scrolls back down`).toBeGreaterThan(0)
      await closeTestApp(app)
      app = undefined
    }
  } finally {
    await closeTestApp(app)
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
