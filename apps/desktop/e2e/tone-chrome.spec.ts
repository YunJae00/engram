import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { appendBotTurn, initVault, type Bot } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../tmp/visual/rd-tone-tokens-chrome/', import.meta.url))
const CANVAS = 'rgb(246, 243, 238)', SURFACE = 'rgb(252, 250, 247)', BUBBLE = 'rgb(239, 235, 230)', INK = 'rgb(28, 27, 25)', CTA_FG = 'rgb(246, 243, 238)'

const isBlue = (color: string) => {
  const [r = 0, g = 0, b = 0] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number)
  return b > r + 40 && b > g + 20
}

async function styleOf(page: Page, selector: string, props: string[], pseudo?: string): Promise<Record<string, string>> {
  return page.evaluate(([selector, props, pseudo]) => {
    const node = document.querySelector(selector as string)
    if (!node) throw new Error(`missing ${selector}`)
    const style = getComputedStyle(node, pseudo as string | undefined)
    return Object.fromEntries((props as string[]).map(prop => [prop, style.getPropertyValue(prop)]))
  }, [selector, props, pseudo] as const)
}

async function focusedRing(page: Page): Promise<{ outline: string; shadow: string; tag: string }> {
  return page.evaluate(() => {
    const node = document.activeElement as HTMLElement
    const style = getComputedStyle(node)
    return { outline: style.outlineColor, shadow: style.boxShadow, tag: `${node.tagName}.${node.className}` }
  })
}

async function expectInkRing(page: Page, field: Locator): Promise<void> {
  await field.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(field).toBeFocused()
  const ring = await field.evaluate(node => {
    const style = getComputedStyle(node)
    return { visible: node.matches(':focus-visible'), width: style.outlineWidth, color: style.outlineColor }
  })
  expect(ring.visible).toBe(true)
  expect(ring.width).toBe('2px')
  expect(ring.color).toBe(INK)
  // box-shadow transitions over 120ms on inputs, so wait for it to settle.
  await expect.poll(() => field.evaluate(node => getComputedStyle(node).boxShadow)).toContain('rgba(28, 27, 25, 0.2)')
}

async function pixel(app: ElectronApplication, page: Page, x: number, y: number): Promise<string> {
  const width = await page.evaluate(() => innerWidth)
  return app.evaluate(async ({ BrowserWindow }, [x, y, width]) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    const image = await window.webContents.capturePage()
    const size = image.getSize(), scale = size.width / width
    const bitmap = image.toBitmap(), at = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4
    return `rgb(${bitmap[at + 2]}, ${bitmap[at + 1]}, ${bitmap[at]})`
  }, [x, y, width] as const)
}

test('cream+ink tokens and chrome on key screens', async () => {
  test.setTimeout(240_000)
  await mkdir(TMP, { recursive: true })
  await mkdir(SHOTS, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'tone-chrome-vault-')), data = await mkdtemp(join(TMP, 'tone-chrome-data-'))
  let app: ElectronApplication | undefined
  try {
    const paths = await initVault(vault, { git: false })
    await writeFile(join(data, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
    app = await electron.launch({
      args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
      env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: data, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
    })
    const page = await app.firstWindow({ timeout: 60_000 })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
    const bots = await page.evaluate(async () => Promise.all(['Research', 'Planner'].map(name => window.engram.botCreate({ name, purpose: '' })))) as Bot[]
    const at = new Date().toISOString()
    for (const bot of bots) {
      await appendBotTurn(paths, bot.id, { role: 'user', text: 'Summarize this week in agents', at })
      await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'Three things stood out. See [the source](https://example.com/agents) for details.', at })
    }
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    const root = await styleOf(page, 'html', ['--bg-canvas', '--bg-surface', '--bg-user-bubble', '--ink', '--cta', '--cta-fg', '--focus-outer'])
    expect(root).toEqual({ '--bg-canvas': '#F6F3EE', '--bg-surface': '#FCFAF7', '--bg-user-bubble': '#EFEBE6', '--ink': '#1C1B19', '--cta': '#1C1B19', '--cta-fg': '#F6F3EE', '--focus-outer': 'rgba(28,27,25,0.20)' })
    expect((await styleOf(page, 'body', ['background-color']))['background-color']).toBe(CANVAS)
    expect((await styleOf(page, '.app-sidebar', ['background-color']))['background-color']).toBe(SURFACE)

    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bots[0]!.id}`).click()
    await expect(page.locator('.bots-thread')).toContainText('Three things stood out')
    expect((await styleOf(page, '.bots-thread .bubble-msg.user', ['background-color', 'border-radius']))).toEqual({ 'background-color': BUBBLE, 'border-radius': '18px' })
    expect((await styleOf(page, '.bots-thread .bubble-msg.assistant', ['background-color']))['background-color']).toBe('rgba(0, 0, 0, 0)')
    const link = await styleOf(page, '.bots-thread .bubble-msg.assistant a', ['color', 'text-decoration-line'])
    expect(isBlue(link.color!), `link ${link.color}`).toBe(false)
    expect(link['text-decoration-line']).toBe('underline')
    const site = await page.locator('.bots-thread .bubble-msg.assistant').first().evaluate(bubble => {
      const anchor = Object.assign(document.createElement('a'), { className: 'answer-site', href: 'https://example.com/agents', textContent: 'Source' })
      bubble.append(anchor)
      const style = getComputedStyle(anchor), result = { color: style.color, line: style.textDecorationLine }
      anchor.remove()
      return result
    })
    expect(site.line, 'answer-site underline').toBe('underline')
    expect(isBlue(site.color), `answer-site ${site.color}`).toBe(false)
    expect((await styleOf(page, '.bots-thread .bubble-msg.assistant', ['background-color'], '::selection'))['background-color']).toBe(INK)

    const write = page.locator('.bots-write')
    await write.locator('textarea').fill('draft for the send button')
    const send = await styleOf(page, '.bots-write .chat-send-btn', ['background-color', 'color', 'border-radius'])
    expect(send).toEqual({ 'background-color': INK, color: CTA_FG, 'border-radius': '50%' })
    expect((await styleOf(page, '.bots-write .chat-send-btn svg', ['color']))['color']).toBe(CTA_FG)
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 800 })
      const gap = await page.evaluate(() => {
        const model = document.querySelector('.bots-write .model-picker-btn')!.getBoundingClientRect()
        const send = document.querySelector('.bots-write .chat-send-btn')!.getBoundingClientRect()
        return Math.abs(model.top - send.top) < model.height ? send.left - model.right : Infinity
      })
      expect(gap, `send/model gap at ${width}px`).toBeGreaterThanOrEqual(8)
    }
    await page.setViewportSize({ width: 1280, height: 800 })

    await expect(page.locator('.bot-info-panel [role="tab"], .bot-info-pane [role="tab"]')).toHaveCount(0)

    const rings: string[] = []
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Tab')
      const ring = await focusedRing(page)
      expect(isBlue(ring.outline), `focus ${ring.tag} ${ring.outline}`).toBe(false)
      expect(isBlue(ring.shadow), `focus ${ring.tag} ${ring.shadow}`).toBe(false)
      rings.push(ring.outline)
    }
    expect(rings).toContain(INK)

    await page.getByTestId('app-sidebar').screenshot({ path: join(SHOTS, 'sidebar-light.png') })
    await page.locator('.bots-thread').screenshot({ path: join(SHOTS, 'chat-light.png') })
    await write.screenshot({ path: join(SHOTS, 'input-light.png') })

    await page.evaluate((ids) => localStorage.setItem('engram.mission.slots', JSON.stringify(ids)), bots.map(bot => bot.id))
    for (const layout of ['mission-layout-2', 'mission-layout-4']) {
      await page.getByTestId(layout).click()
      await expect(page.locator('.mini-chat').first()).toBeVisible()
      await page.waitForTimeout(400)
      for (const selector of ['.mission-tile-body', '.mini-chat']) expect((await styleOf(page, selector, ['background-color']))['background-color'], `${layout} ${selector}`).toBe(CANVAS)
      const empty = await page.evaluate(() => {
        const thread = document.querySelector('.mini-chat-thread')!.getBoundingClientRect()
        for (let y = thread.bottom - 6; y > thread.top + 4; y -= 8) {
          for (let x = thread.left + 6; x < thread.right - 6; x += 8) {
            const hit = document.elementFromPoint(x, y)
            if (hit?.classList.contains('mini-chat-thread')) return [x, y]
          }
        }
        return null
      })
      expect(empty, `${layout} has an empty chat area`).not.toBeNull()
      const seen = (await pixel(app, page, empty![0]!, empty![1]!)).match(/\d+/g)!.map(Number)
      // capturePage goes through the display colour profile, so allow a 2-level rounding drift.
      expect(seen.map((value, index) => Math.abs(value - [246, 243, 238][index]!)).every(delta => delta <= 2), `${layout} empty pixel ${seen}`).toBe(true)
    }
    await openActivity(page, 'bots')

    await openActivity(page, 'settings')
    await expect(page.locator('.settings-page, [data-testid^="settings-nav"]').first()).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'settings-light.png') })
    await page.getByTestId('settings-nav-ai').click()
    await page.getByTestId('key-connection-codex-open').click()
    const url = page.getByTestId('key-connection-codex-url')
    await expect(url).toBeVisible()
    await expectInkRing(page, url)
    await url.blur()
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-overlay')).toHaveCount(0)

    await page.locator('.app-sidebar [data-testid="sidebar-create"]').click()
    await page.getByTestId('bots-new').click()
    const dialog = page.locator('[role="dialog"][data-testid="create-bot-dialog"]')
    await expect(dialog).toBeVisible()
    const box = await styleOf(page, '[data-testid="create-bot-dialog"]', ['background-color'])
    expect([SURFACE, CANVAS]).toContain(box['background-color'])
    await expect(dialog.getByRole('button', { name: /upload|photo/i })).toHaveCount(0)
    await page.keyboard.press('Tab')
    const ring = await focusedRing(page)
    expect(isBlue(ring.outline) || isBlue(ring.shadow), `dialog focus ${ring.tag}`).toBe(false)
    await expectInkRing(page, dialog.getByTestId('create-bot-name'))
    await dialog.screenshot({ path: join(SHOTS, 'dialog-light.png') })
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, data]) await rm(dir, { recursive: true, force: true })
  }
})
