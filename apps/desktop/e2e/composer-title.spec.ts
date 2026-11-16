import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity, openWelcome } from './navigation.js'
import { CHAT_ID, seedVisualVault } from './visual/seed.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))
const BOT_NAME = 'Garden planner'
const VIEW = '[data-testid="bots-view"]'
const BOX = `${VIEW} .bots-write .chat-write`

const rgb = (value: string) => (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
const resolvedColor = (page: Page, value: string) => page.evaluate((value) => {
  const probe = document.createElement('span')
  probe.style.color = value
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}, value)
const accentBlue = (page: Page) => resolvedColor(page, 'var(--accent-blue)')
// The send button wears the theme's call-to-action colour (ink in light since Wave A), falling back to the accent blue.
const sendColor = (page: Page) => resolvedColor(page, 'var(--cta, var(--accent-blue))')
const css = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop)
const box = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().toJSON() as DOMRect)

for (const theme of ['light', 'dark'] as const) {
  test(`bot composer pill and title pill (${theme})`, async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-composer-title-vault-'))
    const profile = await mkdtemp(join(TMP, 'e2e-composer-title-profile-'))
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
    const app = await electron.launch({ args: [MAIN_ENTRY, '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile, ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: MOCK_DIR,
      ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.getByTestId('shell')).toBeVisible()
      await expect(page.getByTestId('sidebar-create')).toBeEnabled()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme)
      const row = page.getByTestId(`bot-${CHAT_ID}`)
      const earlier = page.getByTestId('sidebar-earlier')
      if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
      await row.click()
      await expect(page.locator(`${VIEW} .bubble-msg.user`).first()).toBeVisible()

      const input = page.getByTestId('bots-input')
      const send = page.locator(`${VIEW} .bots-write .chat-send-btn`)
      const write = page.locator(`${VIEW} .bots-write`)
      const blue = await accentBlue(page)

      await input.fill('')
      await expect(send).toBeDisabled()
      // Light dims the ink button while it cannot send; dark swaps to a soft grey at full opacity.
      expect(await css(page, `${VIEW} .bots-write .chat-send-btn`, 'opacity')).toBe(theme === 'light' ? '0.4' : '1')
      const grey = rgb(await css(page, `${VIEW} .bots-write .chat-send-btn`, 'background-color'))
      expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(16)
      // Dark greys the idle button out; light keeps the ink colour (which is also its accent) and dims it instead (opacity above).
      if (theme === 'dark') expect(await css(page, `${VIEW} .bots-write .chat-send-btn`, 'background-color')).not.toBe(blue)

      await input.fill('hi')
      await expect(send).toBeEnabled()
      await expect(send).toHaveCSS('background-color', await sendColor(page))
      await expect(send).toHaveCSS('opacity', '1')
      await expect(send).toHaveCSS('color', 'rgb(255, 255, 255)')
      expect(Math.abs((await box(page, `${VIEW} .bots-write .chat-send-btn`)).width - 30)).toBeLessThanOrEqual(1)

      await expect.poll(() => write.evaluate(node => node.hasAttribute('data-multiline'))).toBe(false)
      expect(parseFloat(await css(page, BOX, 'border-top-left-radius'))).toBeGreaterThanOrEqual(22)
      expect(Math.abs((await box(page, BOX)).height - 44)).toBeLessThanOrEqual(2)

      await input.fill('a\nb\nc')
      await expect.poll(() => write.evaluate(node => node.hasAttribute('data-multiline'))).toBe(true)
      await expect(page.locator(BOX)).toHaveCSS('border-top-left-radius', '22px')
      await input.fill('hi')
      await expect.poll(() => write.evaluate(node => node.hasAttribute('data-multiline'))).toBe(false)
      await input.fill('word '.repeat(80))
      await expect.poll(() => write.evaluate(node => node.hasAttribute('data-multiline'))).toBe(true)

      await input.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'))
      await expect.poll(async () => (await box(page, BOX)).height).toBeGreaterThan(100)
      expect((await box(page, BOX)).height).toBeLessThanOrEqual(200)
      expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
      await input.fill('')
      await expect.poll(() => write.evaluate(node => node.hasAttribute('data-multiline'))).toBe(false)

      await expect(write).toHaveCSS('margin-bottom', '16px')
      const add = await box(page, `${VIEW} .bots-write .chat-add-button`)
      expect(Math.abs(add.width - 28)).toBeLessThanOrEqual(1)
      expect(Math.abs(add.height - 28)).toBeLessThanOrEqual(1)
      expect(await page.locator(`${VIEW} .bots-column`).evaluateAll(nodes => nodes.map(node => node.classList.contains('bots-write')))).toEqual([true])

      const pill = page.locator(`${VIEW} [data-testid="bots-title-pill"]`)
      await expect(pill).toHaveCount(1)
      await expect(pill).toContainText(BOT_NAME)
      const name = pill.locator('.bots-title-pill-name')
      await expect(name).toHaveCSS('font-size', '15px')
      await expect(name).toHaveCSS('font-weight', '500')
      await expect(pill.locator(".bot-avatar[data-size='20']")).toHaveCount(1)
      for (const attr of ['role', 'tabindex', 'onclick']) await expect(pill).not.toHaveAttribute(attr)
      if (theme === 'light') await expect(pill).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('.topbar .bots-head-name')).toHaveCount(0)

      await page.getByTestId('bots-thread').evaluate(node => { node.scrollTop = 0 })
      const first = await box(page, `${VIEW} [data-testid="bots-thread"] .bubble-msg`)
      expect(first.top).toBeGreaterThanOrEqual((await box(page, `${VIEW} [data-testid="bots-title-pill"]`)).bottom)

      // QA145 S24: mid-scroll in a long thread, no visible part of a message comes within 8px of the pill.
      const overlap = await page.getByTestId('bots-thread').evaluate((thread) => {
        for (let i = 0; i < 12; i++) {
          const tall = document.createElement('div')
          tall.className = 'bubble-msg assistant'
          tall.style.cssText = 'min-height: 700px; flex-shrink: 0;'
          tall.textContent = `filler ${i}`
          thread.append(tall)
        }
        const pill = document.querySelector('[data-testid="bots-view"] [data-testid="bots-title-pill"]')!.getBoundingClientRect()
        const worst: number[] = []
        for (const top of [0, 350, thread.scrollHeight / 2, thread.scrollHeight]) {
          thread.scrollTop = top
          const clip = thread.getBoundingClientRect()
          // What is on screen of each message: its box cut to the thread's own box.
          const tops = [...thread.querySelectorAll('.bubble-msg')].map(node => node.getBoundingClientRect())
            .filter(r => r.bottom > clip.top && r.top < clip.bottom && r.right > pill.left && r.left < pill.right)
            .map(r => Math.max(r.top, clip.top))
          worst.push(Math.min(...tops) - pill.bottom)
        }
        const at = document.elementFromPoint(pill.left + pill.width / 2, pill.top + pill.height / 2)
        return { worst, scrolled: thread.scrollTop > 1000, onTop: !!at?.closest('[data-testid="bots-title-pill"]'), mask: getComputedStyle(thread).maskImage }
      })
      expect(overlap.scrolled).toBe(true)
      expect(overlap.onTop).toBe(true)
      for (const gap of overlap.worst) expect(gap).toBeGreaterThanOrEqual(8)
      expect(overlap.mask).toMatch(/^linear-gradient\(rgba\(0, 0, 0, 0\), rgb\(0, 0, 0\) 12px/)

      await openWelcome(page)
      await expect(page.getByTestId('welcome-input')).toBeVisible()
      await expect(page.locator('.comet-welcome .chat-write')).toHaveCSS('border-radius', '22px')
      const welcomeSend = await box(page, '.comet-welcome .chat-send-btn')
      expect([Math.round(welcomeSend.width), Math.round(welcomeSend.height)]).toEqual([32, 32])

      await openActivity(page, 'sky')
      await expect(page.locator('.cosmos-chat .chat-write')).toHaveCSS('border-radius', '22px')
      const cosmosSend = await box(page, '.cosmos-chat .chat-send-btn')
      expect([Math.round(cosmosSend.width), Math.round(cosmosSend.height)]).toEqual([32, 32])
    } finally {
      await closeTestApp(app)
      for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
    }
  })
}
