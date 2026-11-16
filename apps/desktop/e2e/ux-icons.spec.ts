import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORBS } from '../../../packages/core/src/bot-character.js'
import { closeTestApp } from './navigation.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const SHOTS = join(TMP, 'qa', 'icons')
const LEGACY = { character: '09-pill' }
let app: ElectronApplication | undefined
const dirs: string[] = []

async function launch(vault: string, profile: string): Promise<Page> {
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByTestId('shell')).toBeVisible()
  const earlier = page.getByTestId('sidebar-earlier')
  if (await earlier.isVisible()) await earlier.click()
  return page
}

const rowAvatar = (page: Page, id: string) => page.locator(`[data-testid="bot-${id}"] .sidebar-conversation-avatar > .bot-avatar`)
const headerAvatar = (page: Page) => page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar')
const avatarOf = (page: Page, id: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.avatar ?? null, id)

async function openPicker(page: Page, id: string) {
  await page.getByTestId(`bot-${id}`).click()
  await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
  await expect(page.getByTestId('bot-info-pane')).toBeVisible()
  await page.getByTestId('bot-info-avatar').click()
  const picker = page.getByTestId('bot-info-pane').getByTestId('avatar-picker')
  await expect(picker).toBeVisible()
  return picker
}

// Animations whose target sits inside the given avatar, described without leaving the page.
const animationsIn = (page: Page, selector: string) => page.evaluate(selector => {
  const root = document.querySelector(selector)
  return document.getAnimations().filter(a => root?.contains((a.effect as KeyframeEffect | null)?.target ?? null)).map(a => ({
    css: a instanceof CSSAnimation,
    duration: Number((a.effect as KeyframeEffect).getTiming().duration),
    props: [...new Set((a.effect as KeyframeEffect).getKeyframes().flatMap(k => Object.keys(k)))].filter(k => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)),
  }))
}, selector)

test.afterAll(async () => {
  await closeTestApp(app)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test('orb avatars: sidebar, header, picker, persistence across relaunch, and quiet motion', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-ux-icons-')), profile = await mkdtemp(join(TMP, 'e2e-ux-icons-profile-'))
  dirs.push(vault, profile)
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths)
  const now = Date.now()
  const one = await createBot(paths, { name: 'Research' }, new Date(now - 3000))
  const two = await createBot(paths, { name: 'Writing' }, new Date(now - 2000))
  const old = await createBot(paths, { name: 'Legacy face' }, new Date(now - 1000))
  // A conversation is listed once it has a turn.
  for (const [i, bot] of [one, two, old].entries()) await appendBotTurn(paths, bot.id, { role: 'user', text: 'Hello', at: new Date(now - 900 + i * 100).toISOString() })
  const file = join(paths.cache, 'bots.json')
  const stored = JSON.parse(await readFile(file, 'utf8')) as { bots: { id: string; avatar?: unknown }[] }
  stored.bots.find(bot => bot.id === old.id)!.avatar = LEGACY
  await writeFile(file, JSON.stringify(stored))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))

  let page = await launch(vault, profile)
  const ids = [one.id, two.id, old.id]

  // Sidebar: every row is the orb component, never the old character image.
  for (const id of ids) {
    const avatar = rowAvatar(page, id)
    await expect(avatar).toHaveAttribute('data-character', /^orb-/)
    await expect(avatar.locator('.bot-orb')).toHaveCount(1)
    await expect(avatar.locator('.bot-orb svg')).toHaveCount(2)
    await expect(avatar.locator('canvas')).toHaveCount(0)
    await expect(avatar.locator('img')).toHaveCount(0)
  }
  await expect(rowAvatar(page, old.id)).toHaveAttribute('data-character', 'orb-violet')
  await page.getByTestId('app-sidebar').screenshot({ path: join(SHOTS, 'sidebar.png') })

  // Chat header.
  await page.getByTestId(`bot-${one.id}`).click()
  await expect(headerAvatar(page).locator('.bot-orb')).toHaveAttribute('data-motion', 'idle')
  await expect(headerAvatar(page).locator('img')).toHaveCount(0)

  // Picker: exactly the 8 orbs in a 4x2 grid.
  let picker = await openPicker(page, one.id)
  const radios = picker.getByRole('radio')
  await expect(radios).toHaveCount(8)
  expect(await radios.evaluateAll(cells => cells.map(cell => cell.getAttribute('aria-label')))).toEqual([...ORBS])
  await expect(picker.locator('[role="radio"] .bot-orb')).toHaveCount(8)
  await expect(picker.locator('img')).toHaveCount(0)
  const grid = await radios.evaluateAll(cells => cells.map(cell => { const r = cell.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)] }))
  expect(new Set(grid.map(cell => cell[0])).size).toBe(4)
  expect(new Set(grid.map(cell => cell[1])).size).toBe(2)
  await page.getByTestId('bot-info-pane').screenshot({ path: join(SHOTS, 'picker.png') })

  // A pick is written and shown at once.
  const current = await rowAvatar(page, one.id).getAttribute('data-character')
  const choice = ORBS.find(orb => orb !== current)!
  await picker.getByRole('radio', { name: choice, exact: true }).click()
  await expect.poll(() => avatarOf(page, one.id)).toEqual({ character: choice })
  await expect(rowAvatar(page, one.id)).toHaveAttribute('data-character', choice)
  await expect(headerAvatar(page)).toHaveAttribute('data-character', choice)

  // Relaunch: the pick is still there, and the legacy id was displayed without being rewritten.
  await closeTestApp(app)
  page = await launch(vault, profile)
  await expect(rowAvatar(page, one.id)).toHaveAttribute('data-character', choice)
  picker = await openPicker(page, one.id)
  await expect(headerAvatar(page)).toHaveAttribute('data-character', choice)
  await expect(picker.getByRole('radio', { name: choice, exact: true })).toHaveAttribute('aria-checked', 'true')
  expect(await avatarOf(page, old.id)).toEqual(LEGACY)
  await expect(rowAvatar(page, old.id)).toHaveAttribute('data-character', 'orb-violet')
  await page.keyboard.press('Escape')

  // Motion under 64px: CSS animations of transform/opacity only. A 32px row sits still while idle and pulses while working; the 36px header breathes.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => { document.documentElement.dataset['windowFocused'] = 'true' })
  await app!.evaluate(({ BrowserWindow }, event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', event)
  }, { type: 'comet:working', channel: `bot-${two.id}`, working: true })
  const working = `[data-testid="bot-${two.id}"] .sidebar-conversation-avatar > .bot-avatar`
  const idle = `[data-testid="bot-${old.id}"] .sidebar-conversation-avatar > .bot-avatar`
  await expect(page.locator(`${working} .bot-orb`)).toHaveAttribute('data-motion', 'working')
  await expect(page.locator(`${idle} .bot-orb`)).toHaveAttribute('data-motion', 'static')
  for (const row of [working, idle]) {
    await expect(page.locator(`${row} .bot-orb`)).toHaveAttribute('data-master', 'small')
    await expect(page.locator(`${row} .bot-orb`)).not.toHaveAttribute('data-ripple')
  }
  await expect(page.locator(`${working} .bot-orb-work`)).toHaveCSS('opacity', /^(0\.[7-9]\d*|1)$/)
  await expect(page.locator(`${idle} .bot-orb-work`)).toHaveCSS('opacity', '0')
  await page.evaluate(() => { document.documentElement.dataset['windowFocused'] = 'true' })
  // Working: the overlay's pulse. Idle at 32px: nothing. The 36px header: the breathe of the light layer.
  await expect.poll(async () => (await animationsIn(page, working)).length).toBe(1)
  const header = '[data-testid="bots-view"] [data-testid="bots-title-pill"] .bot-avatar'
  const [busy, calm, breathing] = [await animationsIn(page, working), await animationsIn(page, idle), await animationsIn(page, header)]
  expect(calm.length).toBe(0)
  expect(busy.length).toBeGreaterThan(calm.length)
  expect(breathing.map(animation => animation.props)).toEqual([['transform']])
  for (const animation of [...busy, ...calm, ...breathing]) {
    expect(animation.css).toBe(true)
    expect(animation.props.filter(prop => prop !== 'transform' && prop !== 'opacity')).toEqual([])
    expect(animation.duration).toBeGreaterThanOrEqual(8000)
    expect(animation.duration).toBeLessThanOrEqual(12000)
  }

  // Under 64px the animation never touches the DOM, so React has nothing to re-render. The only writes are the ticker's path data on the 64px primary orb.
  await expect(page.locator('[data-testid="app-sidebar"] .bot-orb[data-ripple]')).toHaveCount(1)
  const mutations = await page.evaluate(() => new Promise<number>(done => {
    let count = 0
    const observer = new MutationObserver(list => { count += list.filter(one => !(one.attributeName === 'd' && (one.target as Element).closest('.bot-orb[data-ripple] svg'))).length })
    observer.observe(document.querySelector('[data-testid="app-sidebar"]')!, { subtree: true, childList: true, attributes: true, characterData: true })
    setTimeout(() => { observer.disconnect(); done(count) }, 1500)
  }))
  expect(mutations).toBe(0)
  const cpu: number[] = []
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1000)
    cpu.push(await app!.evaluate(({ app }) => Math.max(0, ...app.getAppMetrics().filter(one => one.type === 'Tab').map(one => one.cpu.percentCPUUsage))))
  }
  expect(Math.min(...cpu), `renderer cpu samples ${cpu.join(', ')}`).toBeLessThan(20)

  // From 64px one shared ticker redraws the wave so the ripple travels: the info pane's 64px orb moves, the 36px header's path never changes.
  await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
  const big = '[data-testid="bot-info-avatar"] .bot-orb'
  await expect(page.locator(big)).toHaveAttribute('data-ripple', 'true')
  await expect(page.locator(`${big} canvas`)).toHaveCount(0)
  const core = (selector: string) => page.evaluate(selector => document.querySelector(`${selector} .bot-orb-core`)!.getAttribute('d'), selector)
  const [bigStart, headerStart] = [await core(big), await core(`${header} .bot-orb`)]
  await expect.poll(() => core(big)).not.toBe(bigStart)
  expect(await core(`${header} .bot-orb`)).toBe(headerStart)
  // The window loses focus: the ripple holds.
  await page.evaluate(() => { document.documentElement.dataset['windowFocused'] = 'false' })
  await page.waitForTimeout(150)
  const held = await core(big)
  await page.waitForTimeout(300)
  expect(await core(big)).toBe(held)
  // The css motion holds too: the 36px header orb's breathe and the working row's pulse are paused, not just the ripple.
  expect(await page.evaluate(() => document.getAnimations().filter(a => (a.effect as KeyframeEffect | null)?.target?.closest('.bot-orb')).map(a => a.playState))).not.toContain('running')
  await page.evaluate(() => { document.documentElement.dataset['windowFocused'] = 'true' })

  // A rippling orb that shrinks is left as the still master of its new size: the full still wave at 48px, the small one at 32px.
  const wave = (selector: string) => page.evaluate(selector => [...document.querySelectorAll(`${selector} path`)].map(path => path.getAttribute('d')).join('|'), selector)
  const resize = async (px: number) => {
    await page.evaluate(px => { const avatar = document.querySelector<HTMLElement>('[data-testid="bot-info-avatar"] .bot-avatar')!; avatar.style.width = avatar.style.height = `${px}px` }, px)
    // Any re-render measures the drawn size again; this one opens or closes the picker.
    await page.getByTestId('bot-info-avatar').click()
  }
  const [fullStill, smallStill] = [await wave(`${header} .bot-orb`), await wave(`${idle} .bot-orb`)]
  expect(fullStill).not.toBe(smallStill)
  for (const [px, master, still] of [[48, 'full', fullStill], [32, 'small', smallStill]] as const) {
    await expect(page.locator(big)).toHaveAttribute('data-ripple', 'true')
    await expect.poll(() => wave(big)).not.toBe(fullStill)
    await resize(px)
    await expect(page.locator(big)).not.toHaveAttribute('data-ripple')
    await expect(page.locator(big)).toHaveAttribute('data-master', master)
    expect(await wave(big)).toBe(still)
    await page.waitForTimeout(300)
    expect(await wave(big)).toBe(still)
    await resize(64)
  }
  await expect(page.locator(big)).toHaveAttribute('data-ripple', 'true')
  await expect.poll(() => wave(big)).not.toBe(fullStill)

  // Reduced motion: a static frame, even for the working row, and the large orb returns to the still wave and stays there.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => core(big)).toBe(headerStart)
  await page.waitForTimeout(300)
  expect(await core(big)).toBe(headerStart)
  await expect(page.locator(`${working} .bot-orb-work`)).toHaveCSS('opacity', '1')
  await expect(page.locator(`${working}[data-state="working"]`)).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => (a.effect as KeyframeEffect | null)?.target?.closest('.bot-avatar')).length)).toBe(0)
  // The ticker asks for no frame while motion is reduced, so the ripple has to start again from the media query's change alone.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => core(big)).not.toBe(headerStart)
})
