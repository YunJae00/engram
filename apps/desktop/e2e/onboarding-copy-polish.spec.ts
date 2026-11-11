import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp } from './navigation.js'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const SHOTS = join(REPO_TMP, 'onboarding-copy-polish')
const OLD_COPY = { heading: 'Choose your workspace', button: 'Choose…', label: 'Choose workspace folder', placeholder: 'Workspace folder' }
const NEW_COPY = { heading: 'Choose a workspace folder', button: 'Browse…', label: 'Browse for workspace folder', placeholder: 'Folder path' }

let app: ElectronApplication
let page: Page
let vaultRoot: string

async function screenshot(name: string) {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes('index.html'))!
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 300))
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
  await writeFile(join(SHOTS, name), Buffer.from(data, 'base64'))
}

async function applyCopy(copy: typeof OLD_COPY) {
  await page.evaluate(next => {
    document.querySelector('.onboard-card h1')!.textContent = next.heading
    const button = document.querySelector<HTMLButtonElement>('.onboard-folder > button')!
    button.textContent = next.button
    button.setAttribute('aria-label', next.label)
    document.querySelector<HTMLInputElement>('[data-testid=vault-root-input]')!.placeholder = next.placeholder
  }, copy)
}

async function expectFits() {
  const report = await page.evaluate(() => {
    const card = document.querySelector('.onboard-card')!.getBoundingClientRect()
    const parts = ['.onboard-card h1', '.onboard-folder > button', '[data-testid=onboard-next]', '.onboard-progress'].map(selector => {
      const element = document.querySelector<HTMLElement>(selector)!
      const box = element.getBoundingClientRect()
      return { selector, clipped: element.scrollWidth > element.clientWidth, inside: box.left >= card.left - 0.5 && box.right <= card.right + 0.5 && box.top >= card.top - 0.5 && box.bottom <= card.bottom + 0.5 }
    })
    const cardElement = document.querySelector<HTMLElement>('.onboard-card')!
    const heading = document.querySelector<HTMLElement>('.onboard-card h1')!
    const lineHeight = parseFloat(getComputedStyle(heading).lineHeight)
    return {
      parts,
      cardOverflow: cardElement.scrollWidth > cardElement.clientWidth,
      headingLines: heading.getBoundingClientRect().height / lineHeight,
      inputWidth: document.querySelector('[data-testid=vault-root-input]')!.getBoundingClientRect().width,
    }
  })
  for (const part of report.parts) expect(part, part.selector).toEqual({ selector: part.selector, clipped: false, inside: true })
  expect(report.cardOverflow).toBe(false)
  expect(report.headingLines).toBeLessThanOrEqual(2.05)
  expect(report.inputWidth).toBeGreaterThan(120)
  await expect(page.locator('.onboard-folder > button')).toBeInViewport()
  await expect(page.getByTestId('onboard-next')).toBeInViewport()
}

test.beforeEach(async () => {
  await mkdir(SHOTS, { recursive: true })
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-home-'))
  vaultRoot = join(await mkdtemp(join(REPO_TMP, 'e2e-copy-')), '작업 공간', 'Engram')
  app = await electron.launch({
    timeout: 90000,
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: '',
      ENGRAM_USERDATA: userData,
      ENGRAM_ONBOARD_ROOT: vaultRoot,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
      ENGRAM_BROWSER_EXTERNAL: '0',
    },
  })
  page = await app.firstWindow({ timeout: 90000 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
})

test.afterEach(async () => {
  await closeTestApp(app)
})

test('first screen copy is concise and consistent', async () => {
  const input = page.getByTestId('vault-root-input')
  const browse = page.getByRole('button', { name: NEW_COPY.label, exact: true })
  await expect(page.getByRole('heading', { name: NEW_COPY.heading, exact: true })).toBeVisible()
  await expect(browse).toHaveText(NEW_COPY.button)
  await expect(input).toHaveAttribute('placeholder', NEW_COPY.placeholder)
  await expect(page.getByRole('textbox', { name: 'Workspace folder', exact: true })).toBeVisible()
  await expect(page.getByTestId('onboard-next')).toHaveText('Continue')
  await expect(page.locator('.onboard-progress')).toHaveText('Engram1 / 4')
  await expect(page.locator('.onboard-progress')).toHaveAttribute('aria-label', 'Step 1 of 4')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByText(OLD_COPY.heading, { exact: true })).toHaveCount(0)
  await expect(page.getByText(OLD_COPY.button, { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue(vaultRoot)
  await app.evaluate(({ ipcMain }, root) => {
    ipcMain.removeHandler('import:pick')
    ipcMain.handle('import:pick', () => root)
  }, vaultRoot)
  await browse.click()
  await expect(input).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(input).toHaveValue(vaultRoot)
})

test('folder picker failure keeps the typed path and offers a way forward', async () => {
  const input = page.getByTestId('vault-root-input')
  const typed = join(vaultRoot, '..', '내 폴더')
  await input.fill(typed)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('import:pick')
    ipcMain.handle('import:pick', () => { throw new Error('picker unavailable') })
  })
  await page.getByRole('button', { name: NEW_COPY.label, exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Could not open the folder picker. Type a path instead.')
  await expect(page.getByTestId('onboard-brains-retry')).toHaveCount(0)
  await expect(input).toHaveValue(typed)
  await expect(page.getByTestId('onboard-next')).toBeEnabled()
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('missing default folder asks the user to choose one', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('onboard:defaults')
    ipcMain.handle('onboard:defaults', () => { throw new Error('no defaults') })
  })
  await page.reload()
  const input = page.getByTestId('vault-root-input')
  await expect(page.getByRole('alert')).toHaveText('Could not suggest a folder. Choose one to continue.')
  await expect(page.getByTestId('onboard-brains-retry')).toHaveCount(0)
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('onboard-next')).toBeDisabled()
  await input.fill('   ')
  await expect(page.getByTestId('onboard-next')).toBeDisabled()
  await input.fill(vaultRoot)
  await expect(page.getByTestId('onboard-next')).toBeEnabled()
})

test('first screen fits without clipping at normal and narrow sizes', async () => {
  for (const [width, height] of [[900, 700], [400, 640]] as const) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes('index.html'))!
      win.setMinimumSize(0, 0)
      win.setContentSize(size.width, size.height)
    }, { width, height })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      for (const [label, copy] of [['before', OLD_COPY], ['after', NEW_COPY]] as const) {
        await applyCopy(copy)
        await expectFits()
        await screenshot(`${label}-${width}x${height}-${theme}.png`)
      }
    }
  }
  await expect(page.getByRole('heading', { name: NEW_COPY.heading, exact: true })).toBeVisible()
})
