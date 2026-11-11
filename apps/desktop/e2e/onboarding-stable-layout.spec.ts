import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { closeTestApp } from './navigation.js'
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Onboarding keeps its title, Back and primary button still across steps.
// Baselines in fixtures/onboarding-stable-layout were captured from the code before this change
// with ONBOARD_SHOTS=before; a normal run copies them next to the after shots it writes.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const BASELINE = fileURLToPath(new URL('./fixtures/onboarding-stable-layout/', import.meta.url))
const SHOTS = join(REPO_TMP, 'onboarding-preview', 'stable-layout')
const PHASE = process.env['ONBOARD_SHOTS'] === 'before' ? 'before' : 'after'

type Box = { top: number, left: number, right: number }
let app: ElectronApplication
let page: Page

const h1 = () => page.locator('.onboard-card h1')
const primary = () => page.locator('.onboard-actions > .primary')
const back = () => page.getByRole('button', { name: 'Back', exact: true })
const box = (locator: Locator): Promise<Box> => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right } })

async function size(width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes('index.html'))!
    win.setMinimumSize(0, 0); win.setContentSize(w!, h!)
  }, [width, height])
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}
async function screenshot(name: string) {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes('index.html'))!
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
  await writeFile(join(SHOTS, `${PHASE}-${name}.png`), Buffer.from(data, 'base64'))
}
const pngSize = async (file: string) => { const png = await readFile(file); return [png.readUInt32BE(16), png.readUInt32BE(20)] }
async function toStep2() {
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
}
async function pickModel() {
  await page.getByTestId('onboard-choose-codex').check()
  await page.getByTestId('onboard-model').click()
  await page.getByRole('menuitemradio', { name: 'Quick model', exact: true }).click()
  await expect(page.getByTestId('onboard-ai-next')).toBeEnabled()
}
async function toStep3() {
  await toStep2(); await pickModel()
  await page.getByTestId('onboard-ai-next').click()
  await expect(page.getByTestId('onboard-step-3')).toBeVisible()
}
const checks = () => app.evaluate(() => (globalThis as { checks?: number }).checks ?? 0)

test.beforeEach(async () => {
  await mkdir(SHOTS, { recursive: true })
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-home-'))
  app = await electron.launch({
    timeout: 90000,
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: '',
      ENGRAM_USERDATA: userData,
      ENGRAM_ONBOARD_ROOT: join(await mkdtemp(join(REPO_TMP, 'e2e-onboard-')), 'Engram'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
      ENGRAM_BROWSER_EXTERNAL: '0',
    },
  })
  page = await app.firstWindow({ timeout: 90000 })
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const held = globalThis as { holdCheck?: boolean, releaseCheck?: (rows: unknown[]) => void, checks?: number }
    const rows = [{ id: 'claude', installed: true, loggedIn: true }, { id: 'codex', installed: true, loggedIn: true }]
    ipcMain.removeHandler('models:list')
    ipcMain.handle('models:list', (_event, id: string) => [{ value: `${id}-quick`, label: 'Quick model', detail: 'Fixture' }])
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', (_event, ids?: string[]) => {
      if (!ids) return rows
      held.checks = (held.checks ?? 0) + 1
      return held.holdCheck ? new Promise(resolve => { held.releaseCheck = resolve }) : rows.filter(row => ids.includes(row.id))
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  })
  page.on('pageerror', err => console.error('[renderer pageerror]', err))
  await size(1100, 800)
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
  await expect(page.getByTestId('onboard-next')).toBeEnabled()
})

test.afterEach(async () => {
  await closeTestApp(app)
})

test('captures each step at one size', async () => {
  const metrics: Record<string, number[]> = {}
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset['theme'] = value }, theme)
    if (theme === 'dark') { await back().click(); await back().click() }
    const tops: number[] = []
    await expect(h1()).toBeVisible(); tops.push((await box(h1())).top); await screenshot(`${theme}-step-1`)
    await toStep2()
    if (theme === 'light') await pickModel()
    await page.waitForTimeout(300)
    await expect(h1()).toBeVisible(); tops.push((await box(h1())).top); await screenshot(`${theme}-step-2`)
    await page.getByTestId('onboard-ai-next').click()
    await expect(page.getByTestId('onboard-step-3')).toBeVisible()
    await expect(h1()).toBeVisible(); tops.push((await box(h1())).top); await screenshot(`${theme}-step-3`)
    metrics[theme] = tops
  }
  await writeFile(join(SHOTS, `${PHASE}-metrics.json`), JSON.stringify(metrics, null, 2))
  if (PHASE === 'before') return
  const spread = (tops: number[]) => Math.max(...tops) - Math.min(...tops)
  for (const name of await readdir(BASELINE)) await copyFile(join(BASELINE, name), join(SHOTS, name))
  const before = JSON.parse(await readFile(join(SHOTS, 'before-metrics.json'), 'utf8')) as Record<string, number[]>
  for (const theme of ['light', 'dark']) {
    expect(spread(before[theme]!)).toBeGreaterThan(100)
    expect(spread(metrics[theme]!)).toBeLessThanOrEqual(1)
    for (const step of [1, 2, 3]) {
      const name = `${theme}-step-${step}.png`
      expect(await pngSize(join(SHOTS, `before-${name}`)), name).toEqual(await pngSize(join(SHOTS, `after-${name}`)))
    }
  }
})

test('title and controls hold still across steps', async () => {
  const titles: Box[] = [await box(h1())], primaries: Box[] = [await box(primary())], backs: Box[] = []
  const record = async () => { titles.push(await box(h1())); primaries.push(await box(primary())); backs.push(await box(back())) }
  await toStep2(); await record()
  await pickModel(); await page.waitForTimeout(300); await record()
  const content = await page.locator('.onboard-ai-content').evaluate(el => [el.scrollHeight, el.clientHeight])
  expect(content[0]!, 'step 2 fits without an inner scroll').toBeLessThanOrEqual(content[1]! + 1)
  await page.getByTestId('onboard-ai-next').click()
  await expect(page.getByTestId('onboard-step-3')).toBeVisible(); await record()
  await app.evaluate(() => { (globalThis as { holdCheck?: boolean }).holdCheck = true })
  await page.getByTestId('onboard-prefs-next').click()
  await expect(page.getByTestId('onboard-step-4')).toBeVisible(); await record()
  await page.getByTestId('onboard-finish').click()
  await expect(page.getByTestId('onboard-finish')).toContainText('Checking AI…'); await record()
  await app.evaluate(() => { (globalThis as { releaseCheck?: (rows: unknown[]) => void }).releaseCheck!([]) })
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('not verified'); await record()
  for (const title of titles) { expect(Math.abs(title.top - titles[0]!.top)).toBeLessThanOrEqual(1); expect(Math.abs(title.left - titles[0]!.left)).toBeLessThanOrEqual(1) }
  for (const button of primaries) { expect(Math.abs(button.top - primaries[0]!.top)).toBeLessThanOrEqual(1); expect(Math.abs(button.right - primaries[0]!.right)).toBeLessThanOrEqual(1) }
  for (const button of backs) { expect(Math.abs(button.top - backs[0]!.top)).toBeLessThanOrEqual(1); expect(Math.abs(button.left - backs[0]!.left)).toBeLessThanOrEqual(1) }
})

test('Back keeps its node and colour through a step change', async () => {
  await primary().evaluate(el => el.setAttribute('data-probe', '1'))
  await toStep3()
  await expect(primary()).toHaveAttribute('data-probe', '1')
  await back().evaluate(el => el.setAttribute('data-probe', '1'))
  await back().hover()
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const samples: string[] = []
    ;(window as { samples?: string[] }).samples = samples
    const timer = setInterval(() => {
      for (const el of document.querySelectorAll('.onboard-actions button.secondary')) { const s = getComputedStyle(el); samples.push(`${s.backgroundColor}|${s.borderColor}|${s.color}`) }
    }, 8)
    setTimeout(() => clearInterval(timer), 400)
  })
  await back().click()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await page.waitForTimeout(450)
  const samples = await page.evaluate(() => (window as { samples?: string[] }).samples!)
  expect(samples.length).toBeGreaterThan(10)
  expect(new Set(samples).size).toBe(1)
  await expect(back()).toHaveAttribute('data-probe', '1')
})

test('double-click and keyboard do not skip steps or drop focus', async () => {
  await page.getByTestId('onboard-next').dblclick()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await pickModel()
  await page.getByTestId('onboard-ai-next').dblclick()
  await expect(page.getByTestId('onboard-step-3')).toBeVisible()
  await expect(page.getByTestId('onboard-prefs-next')).toHaveText('Continue')
  await page.waitForTimeout(300)
  expect(await checks()).toBe(0)
  await back().dblclick()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await page.waitForTimeout(300)
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(page.getByTestId('onboard-step-1')).toHaveCount(0)
  await back().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
  await expect(page.getByTestId('onboard-next')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(primary()).toBeFocused()
})

test('narrow and short windows keep every control reachable', async () => {
  for (const [width, height] of [[480, 520], [600, 600]] as const) {
    await size(width, height)
    if (await page.getByTestId('onboard-step-1').count() === 0) { await back().click(); await back().click() }
    const tops: number[] = []
    for (const step of [1, 2, 3]) {
      if (step === 2) await toStep2()
      if (step === 2 && await page.getByTestId('onboard-model').count() === 0) await pickModel()
      if (step === 3) { await page.getByTestId('onboard-ai-next').click(); await expect(page.getByTestId('onboard-step-3')).toBeVisible() }
      await expect(h1()).toBeInViewport()
      await expect(primary()).toBeInViewport()
      if (step > 1) await expect(back()).toBeInViewport()
      const card = await page.locator('.onboard-card').evaluate(el => [el.scrollWidth, el.clientWidth])
      expect(card[0]!).toBeLessThanOrEqual(card[1]!)
      tops.push((await box(h1())).top)
      if (step === 2 && width === 480) {
        const content = await page.locator('.onboard-ai-content').evaluate(el => [el.scrollHeight, el.clientHeight])
        expect(content[0]!).toBeGreaterThan(content[1]!)
        await page.getByTestId('onboard-model').scrollIntoViewIfNeeded()
        await expect(page.getByTestId('onboard-model')).toBeInViewport()
      }
    }
    expect(Math.max(...tops) - Math.min(...tops), `${width}x${height}`).toBeLessThanOrEqual(1)
  }
})
