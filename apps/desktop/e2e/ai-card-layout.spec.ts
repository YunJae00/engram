import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'ai-card-layout-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'ai-card-layout-userdata-')),
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    const handle = (name: string, fn: () => unknown) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn) }
    handle('engines:states', () => [{ id: 'claude', installed: false, loggedIn: false }, { id: 'codex', installed: true, loggedIn: true }])
    handle('engines:logins', () => [])
    handle('accounts:list', () => ({ profiles: [], selected: { claude: 'system', codex: 'system' } }))
    handle('devUsage', () => ({ windows: [{ name: 'Weekly', used: 6 }], updatedAt: 1 }))
    handle('update:check', () => ({ state: 'current', selfInstalls: false }))
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test.afterEach(async () => { await app?.close() })

async function screenshot(name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('index.html'))!
    await win.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, name), Buffer.from(png, 'base64'))
}

test('AI cards separate account details from actions and show a calm connected badge', async () => {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  const settings = page.getByTestId('settings-view')
  const claude = settings.getByRole('region', { name: 'Claude connection', exact: true })
  const codex = settings.getByRole('region', { name: 'ChatGPT connection', exact: true })
  await expect(claude.getByRole('button', { name: 'Install Claude runtime', exact: true })).toBeVisible()
  const connected = page.getByTestId('brain-codex-status')
  await expect(connected).toHaveText('Connected')
  await codex.getByRole('button', { name: 'Refresh ChatGPT usage' }).click()
  await expect(codex).toContainText('94% remaining')
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(value => window.engram.settingsSet({ theme: value }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(connected).toHaveCSS('color', theme === 'light' ? 'rgb(61, 116, 83)' : 'rgb(159, 199, 173)')
    await expect(connected).toHaveAttribute('data-connected', 'true')
    expect(await connected.evaluate(node => getComputedStyle(node, '::before').backgroundColor)).toBe(theme === 'light' ? 'rgb(61, 116, 83)' : 'rgb(159, 199, 173)')
    for (const width of [1024, 600]) {
      await page.setViewportSize({ width, height: 800 })
      for (const card of [claude, codex]) {
        const geometry = await card.evaluate(node => {
          const rect = node.getBoundingClientRect()
          const heading = node.querySelector('.engine-card-heading')!.getBoundingClientRect()
          const actions = node.querySelector('.engine-actions')!.getBoundingClientRect()
          const buttons = [...node.querySelectorAll('.engine-actions button')].map(value => value.getBoundingClientRect())
          return {
            separation: actions.top - heading.bottom,
            contained: buttons.every(box => box.left >= rect.left && box.right <= rect.right),
            nonOverlapping: buttons.every((a, index) => buttons.slice(index + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)),
            noOverflow: node.scrollWidth <= node.clientWidth,
          }
        })
        expect(geometry.separation).toBeGreaterThanOrEqual(12)
        expect(geometry.contained && geometry.nonOverlapping && geometry.noOverflow).toBe(true)
      }
      expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await screenshot(`ai-cards-${theme}-${width}.png`)
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', {
      type: 'engines:login', login: { id: 'codex', phase: 'browser', canOpen: true },
    })
  })
  await expect(connected).toHaveText('Finish signing in in your browser')
  await expect(connected).toHaveAttribute('data-connected', 'false')
  await expect(codex.getByRole('button', { name: 'Open browser' })).toBeVisible()
  await expect(codex.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(codex.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
})
