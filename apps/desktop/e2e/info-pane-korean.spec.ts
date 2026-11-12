import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const PARENTHESISED = ['이(가)', '을(를)', '은(는)', '과(와)', '(으)로']
let app: ElectronApplication | undefined
const dirs: string[] = []

test.afterEach(async () => {
  await closeTestApp(app)
  app = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('the details pane uses the right Korean particle for the bot name', async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-info-pane-ko-')), profile = await mkdtemp(join(TMP, 'e2e-info-pane-ko-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'ko' }))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('activity-settings')).toHaveAttribute('aria-label', '설정')
  const ids = await page.evaluate(async () => Promise.all(['리서치', '아침 날씨'].map(async name => (await window.engram.botCreate({ name, purpose: '' })).id)))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()

  for (const [i, name] of ['리서치', '아침 날씨'].entries()) {
    const row = page.getByTestId(`bot-${ids[i]}`), earlier = page.getByTestId('sidebar-earlier')
    if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
    await row.click()
    const pane = page.getByTestId('bot-info-pane')
    if (!await pane.isVisible()) await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    await expect(pane.locator('h2')).toHaveText(name)
    await expect(pane.getByTestId('bots-memory')).toBeVisible()
    const text = await pane.innerText()
    expect(text, `PARTICLE ${name}: ${text}`).toContain(`${name}가 나에 대해 기억하는 것`)
    for (const form of PARENTHESISED) expect(text, `PARTICLE ${name}: '${form}' in ${text}`).not.toContain(form)
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'))
    await test.info().attach(`details-pane-${i}.png`, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
  }
})
