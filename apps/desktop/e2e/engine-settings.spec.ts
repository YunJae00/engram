import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngineLoginDto } from '../src/shared/types.js'
test.describe.configure({ mode: 'serial' })

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
type Fixture = { delayed: boolean; signed: Record<string, boolean>; login: EngineLoginDto[]; opened: number; finish?: () => void; modelReplies?: Array<() => void> }
type Global = typeof globalThis & { engineFixture: Fixture }
test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-engines-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-engines-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const state: Fixture = { delayed: true, signed: { claude: false, codex: false }, login: [], opened: 0 }
    ;(globalThis as Global).engineFixture = state
    const tell = (login: EngineLoginDto) => { state.login = [login]; for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:login', login }) }
    const handle = (name: string, fn: (...args: unknown[]) => unknown) => { ipcMain.removeHandler(name); ipcMain.handle(name, (_event, ...args) => fn(...args)) }
    handle('engines:states', () => state.delayed ? new Promise(() => undefined) : ['claude', 'codex'].map((id) => ({ id, installed: true, loggedIn: state.signed[id] })))
    handle('engines:logins', () => state.login)
    handle('models:list', (id) => [{ value: `${id}-fast`, label: 'Quick', detail: 'For everyday work', efforts: ['low', 'medium', 'high'] }, { value: `${id}-deep`, label: 'Thorough', detail: 'For harder tasks', efforts: ['low', 'medium', 'high', 'xhigh'] }])
    handle('engines:connect', (value) => {
      const id = value as 'claude' | 'codex'
      tell({ id, phase: 'browser', canOpen: true })
      return new Promise((resolve) => { state.finish = () => { state.signed[id] = true; tell({ id, phase: 'connected', canOpen: false }); resolve({ ok: true }) } })
    })
    handle('engines:openLogin', () => { state.opened++ })
    handle('engines:cancelLogin', (id) => { tell({ id: id as 'claude' | 'codex', phase: 'idle', canOpen: false }); state.finish = undefined })
  })
  await page.setViewportSize({ width: 1280, height: 880 })
})
test.afterAll(async () => { await app?.close() })

test('settings stays usable while a runtime probe never answers', async () => {
  await openActivity(page, 'settings')
  await expect(page.getByTestId('settings-nav-ai')).toBeEnabled({ timeout: 2000 })
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-claude-status')).toContainText('Checking connection')
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
})

test('memory settings and the app expose no browser video recording controls', async () => {
  for (let visit = 0; visit < 2; visit++) {
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-memory').click()
    await expect(page.getByTestId('setting-work-map')).toBeVisible()
    await expect(page.getByTestId('task-recording-settings')).toHaveCount(0)
    await expect(page.getByTestId('setting-record-tasks')).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Browser recording' })).toHaveCount(0)
    expect(await page.evaluate(() => ['evidenceStatus' in window.engram, 'evidenceStop' in window.engram])).toEqual([false, false])
    expect(await page.evaluate(async () => 'recordTasks' in await window.engram.settingsGet())).toBe(false)
    await page.getByTestId('settings-view').getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByTestId('settings-view')).toHaveCount(0)
  }
})

test('both sign-in cards survive reopening settings and offer cancel and browser recovery', async () => {
  await app.evaluate(() => { (globalThis as Global).engineFixture.delayed = false })
  for (const id of ['claude', 'codex']) {
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-ai').click()
    await page.getByTestId(`brain-${id}-connect`).click()
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Finish signing in')
    await page.keyboard.press('Escape')
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-ai').click()
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Finish signing in')
    await page.getByRole('button', { name: 'Open browser' }).click()
    await page.getByTestId(`brain-${id}-cancel`).click()
    await expect(page.getByTestId(`brain-${id}-connect`)).toBeEnabled()
    await page.getByTestId(`brain-${id}-connect`).click()
    await app.evaluate(() => (globalThis as Global).engineFixture.finish?.())
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Connected')
    await expect(page.getByTestId('model-picker')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-view')).toHaveCount(0)
  }
  expect(await app.evaluate(() => (globalThis as Global).engineFixture.opened)).toBe(2)
})

test('the composer offers no model picker and new conversations stay on Claude', async () => {
  await expect(page.getByTestId('welcome-input')).toBeVisible()
  await expect(page.getByTestId('model-picker')).toHaveCount(0)
  expect(await page.evaluate(async () => (await window.engram.settingsGet()).defaultEngine)).toBe('claude')
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, 'engine-settings-light.png'), Buffer.from(png, 'base64'))
  await page.keyboard.press('Escape')
})

test('the main banner and filing status recover alongside the connected settings card', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'engines:detected' })
      window.webContents.send('engram:event', { type: 'engines:changed', engines: [] })
    }
  })
  await expect(page.getByTestId('sweep-status')).toHaveText('Filing AI unavailable')
  await app.evaluate(({ BrowserWindow }) => {
    const fixture = (globalThis as Global).engineFixture
    fixture.delayed = false; fixture.signed['codex'] = true
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('engram:event', { type: 'engines:detected' })
      window.webContents.send('engram:event', { type: 'engines:changed', engines: [] })
      window.webContents.send('engram:event', { type: 'sweep:error', message: 'No engine available — connect an AI to start auto-organizing.' })
    }
  })
  await expect(page.getByTestId('connect-banner')).toBeVisible()
  await expect(page.getByTestId('sweep-status')).toHaveText('Filing AI unavailable')
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'engines:changed', engines: [{ id: 'codex', installed: true, loggedIn: true, healthy: true }] })
  })
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)
  await expect(page.getByTestId('sweep-status')).toHaveText('Filing ready')
  await expect(page.getByTestId('engine-status')).toHaveCount(0)
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-codex-status')).toHaveText('Connected')
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'engine:health', id: 'codex', healthy: false, reason: 'auth' })
  })
  await expect(page.getByTestId('sweep-status')).toHaveText('Filing AI unavailable')
  await page.getByTestId('unhealthy-banner').getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page.getByTestId('settings-nav-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('diagnostics-view')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'engine:health', id: 'codex', healthy: true })
  })
  await expect(page.getByTestId('unhealthy-banner')).toHaveCount(0)
})

test('composer and AI defaults show no provider picker while the filing test stays available', async () => {
  await expect(page.getByTestId('model-picker')).toHaveCount(0)
  await expect(page.getByTestId('engine-status')).toHaveCount(0)
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByRole('region', { name: 'New conversation model', exact: true }).getByTestId('model-picker')).toHaveCount(0)
  const filing = page.getByRole('region', { name: 'Filing model', exact: true })
  await expect(filing.getByTestId('model-picker')).toHaveCount(0)
  await expect(filing.getByTestId('ai-check-filing')).toBeEnabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(async () => (await window.engram.settingsGet()).defaultEngine)).toBe('claude')
})

test('no provider menu appears in wide or compact windows', async () => {
  const sidebar = page.getByTestId('app-sidebar')
  for (const size of [{ width: 1280, height: 880 }, { width: 620, height: 480 }]) {
    await page.setViewportSize(size)
    if (size.width < 900 && await sidebar.getAttribute('aria-hidden') === 'false') {
      await page.getByTestId('app-sidebar-close').click()
      await expect(sidebar).toBeHidden()
    }
    await expect(page.getByTestId('welcome-input')).toBeVisible()
    await expect(page.getByTestId('model-picker')).toHaveCount(0)
    await expect(page.getByTestId('model-picker-menu')).toHaveCount(0)
    if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('engine-status')).toHaveCount(0)
  }
  await page.setViewportSize({ width: 1280, height: 880 })
  if (await sidebar.getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
})

test('a disconnected Claude account shows in AI settings without changing accounts or engine', async () => {
  await app.evaluate(() => { (globalThis as Global).engineFixture.signed.claude = false })
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-claude-connect')).toBeEnabled()
  expect(await page.evaluate(async () => (await window.engram.settingsGet()).defaultEngine)).toBe('claude')
  expect(await app.evaluate(() => { const state = (globalThis as Global).engineFixture; return { signed: state.signed, login: state.login } })).toEqual({ signed: { claude: false, codex: true }, login: [{ id: 'codex', phase: 'connected', canOpen: false }] })
  await page.keyboard.press('Escape')
})

test('welcome and conversation footer controls align inside narrow composers without a model picker', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByTestId('sidebar-create').click(); await page.getByTestId('bots-new').click(); await page.keyboard.press('Escape')
  for (const surface of ['welcome', 'conversation']) {
    if (surface === 'conversation') {
      await page.setViewportSize({ width: 1280, height: 880 })
      if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
      const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Composer alignment', purpose: '' }))
      await page.getByTestId(`bot-${bot.id}`).click()
    }
    const input = page.getByTestId(surface === 'welcome' ? 'welcome-input' : 'bots-input')
    for (const width of [1280, 620, 380]) {
      await page.setViewportSize({ width, height: 880 })
      const sidebar = page.getByTestId('app-sidebar')
      if (await sidebar.getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
      await expect(sidebar).toBeHidden()
      await expect(input).toBeVisible()
      const composer = page.locator('.chat-write').filter({ has: input })
      await expect(composer.getByTestId('model-picker')).toHaveCount(0)
      if (surface === 'conversation') {
        const memory = composer.getByTestId('bots-memory-toggle')
        await composer.getByRole('button', { name: 'Add to conversation', exact: true }).click()
        await expect(memory).toHaveText('Memory')
        await expect(memory).toHaveAttribute('title', /\S/)
        await expect(memory).toHaveAttribute('aria-label', /\S/)
        await memory.click()
        await expect(memory).toHaveAttribute('aria-pressed', 'true')
        await composer.getByRole('button', { name: 'Add to conversation', exact: true }).click()
        await memory.click()
        await expect(memory).toHaveAttribute('aria-pressed', 'false')
      }
      const geometry = await composer.evaluate(node => {
        const footer = node.querySelector('.chat-write-footer')!.getBoundingClientRect()
        const tools = node.querySelector('.chat-write-tools')!
        const buttons = [...node.querySelectorAll('.chat-write-footer button')].map(button => button.getBoundingClientRect())
        const icons = [...node.querySelectorAll('.chat-write-footer button > svg')].map(icon => icon.getBoundingClientRect())
        const children = [...tools.children].filter(child => child.tagName !== 'INPUT').map(child => child.getBoundingClientRect())
        const centers = icons.map(box => box.top + box.height / 2)
        return {
          height: node.getBoundingClientRect().height,
          inputCenter: node.querySelector('textarea')!.getBoundingClientRect().top + node.querySelector('textarea')!.getBoundingClientRect().height / 2,
          footerCenter: footer.top + footer.height / 2,
          buttons: buttons.map(box => box.height), icons: icons.map(box => [box.width, box.height]),
          iconButtons: [...tools.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect().width),
          centerSpread: Math.max(...centers) - Math.min(...centers),
          gaps: children.slice(1).map((box, index) => box.left - children[index]!.right),
          contained: footer.left >= 0 && footer.right <= innerWidth && buttons.every(box => box.left >= footer.left && box.right <= footer.right),
          toolsOverflow: tools.scrollWidth - tools.clientWidth,
        }
      })
      const diagnostic = JSON.stringify({ surface, width, ...geometry })
      expect(geometry.height, diagnostic).toBeLessThanOrEqual(54)
      expect(Math.abs(geometry.inputCenter - geometry.footerCenter), diagnostic).toBeLessThanOrEqual(1)
      expect(geometry.buttons, diagnostic).toEqual(geometry.buttons.map(() => 32))
      expect(geometry.iconButtons, diagnostic).toEqual(geometry.iconButtons.map(() => 32))
      expect(geometry.icons, diagnostic).toEqual(geometry.icons.map(() => [16, 16]))
      expect(geometry.centerSpread, diagnostic).toBeLessThanOrEqual(0.5)
      expect(geometry.gaps.slice(0, -1), diagnostic).toEqual(geometry.gaps.slice(0, -1).map(() => 4))
      if (geometry.gaps.length) expect(geometry.gaps.at(-1), diagnostic).toBeGreaterThanOrEqual(4)
      expect(geometry.contained, diagnostic).toBe(true)
      expect(geometry.toolsOverflow, diagnostic).toBeLessThanOrEqual(1)
      if (surface === 'conversation' && width === 620) {
        const png = await app.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!
          await window.webContents.capturePage()
          await new Promise(resolve => setTimeout(resolve, 400))
          return (await window.webContents.capturePage()).toPNG().toString('base64')
        })
        await writeFile(join(TMP, 'composer-controls-620.png'), Buffer.from(png, 'base64'))
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 880 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test('stored conversation and filing selections read back on Claude without effort and the bot composer has no picker', async () => {
  await app.evaluate(() => { (globalThis as Global).engineFixture.signed = { claude: true, codex: true } })
  const ids = await page.evaluate(async () => {
    const a = await window.engram.botCreate({ name: 'Independent A' })
    const b = await window.engram.botCreate({ name: 'Independent B' })
    await Promise.all([
      window.engram.aiSelectionSet('bot-' + a.id, { engine: 'claude', model: 'claude-fast' }),
      window.engram.aiSelectionSet('bot-' + b.id, { engine: 'codex', model: 'codex-deep' }),
      window.engram.aiSelectionSet('filing', { engine: 'codex', model: 'codex-fast', effort: 'low' }),
    ])
    return [a.id, b.id]
  })
  await openActivity(page, 'bots')
  await page.getByTestId('bot-' + ids[0]).click()
  await expect(page.getByTestId('bots-input')).toBeVisible()
  await expect(page.locator('.bots-write').getByTestId('model-picker')).toHaveCount(0)
  await expect(page.getByTestId('effort-picker')).toHaveCount(0)
  await page.reload()
  const choices = await page.evaluate(() => window.engram.settingsGet().then(settings => settings.aiSelections))
  expect(choices?.['bot-' + ids[0]]).toEqual({ engine: 'claude', model: 'claude-fast' })
  expect(choices?.['bot-' + ids[1]]).toEqual({ engine: 'claude', model: 'codex-deep' })
  expect(choices?.filing).toEqual({ engine: 'claude', model: 'codex-fast' })
  await page.evaluate(async () => {
    const settings = await window.engram.settingsGet()
    await window.engram.settingsSet({ ...settings, defaultEngine: 'claude', claudeModel: 'claude-fast' })
  })
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => settings.aiSelections))).toEqual(choices)
})

test('the composer shows no model menu after reload while the catalog request is stalled', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('models:list')
    // Keep the reply alive: Electron rejects an unreachable pending reply during GC.
    const replies = (globalThis as Global).engineFixture.modelReplies = [] as Array<() => void>
    ipcMain.handle('models:list', () => new Promise<void>(resolve => { replies.push(resolve) }))
  })
  await page.reload()
  await page.getByTestId('sidebar-create').click(); await page.getByTestId('bots-new').click(); await page.keyboard.press('Escape')
  await expect(page.getByTestId('welcome-input')).toBeEditable()
  await expect(page.getByTestId('model-picker')).toHaveCount(0)
  await expect(page.getByTestId('model-picker-menu')).toHaveCount(0)
})

test('Claude keeps its brand color on the sign-in card in both themes', async () => {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    const icon = page.locator('.engine-identity > .provider-icon[data-provider="claude"]')
    await expect(icon).toBeVisible()
    await expect(icon).toHaveCSS('color', 'rgb(197, 118, 85)')
    await page.screenshot({ path: join(TMP, `claude-sign-in-${theme}.png`) })
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.keyboard.press('Escape')
})

test('a newer update replaces stale restart actions in the banner and settings', async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    let state = { state: 'ready', version: '9.0.1', selfInstalls: true, percent: 100 }
    for (const name of ['update:check', 'update:state', 'update:install']) ipcMain.removeHandler(name)
    ipcMain.handle('update:check', () => state)
    ipcMain.handle('update:state', () => state)
    ipcMain.handle('update:install', () => {
      state = { state: 'downloading', version: '9.0.2', selfInstalls: true, percent: 12 }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'update:changed', update: state })
      return { started: false, reason: 'downloading' }
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'update:changed', update: state })
  })
  const banner = page.getByTestId('update-banner')
  await expect(banner).toContainText('9.0.1')
  await banner.getByRole('button', { name: 'Restart now' }).click()
  await expect(banner).toContainText('9.0.2')
  await expect(banner.getByRole('button')).toBeDisabled()
  await expect(banner.getByText('Restart now')).toHaveCount(0)
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-help').click()
  await expect(page.getByTestId('settings-update')).toContainText('9.0.2')
  await expect(page.getByTestId('settings-update').getByRole('progressbar')).toHaveAttribute('value', '12')
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'update:changed', update: { state: 'ready', version: '9.0.2', selfInstalls: true } })
  })
  await expect(page.getByTestId('settings-update').getByRole('button', { name: 'Restart now' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(banner.getByRole('button', { name: 'Restart now' })).toBeEnabled()
})
