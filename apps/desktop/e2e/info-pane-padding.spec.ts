import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const GUTTER = 24, STRIP = 20, TOLERANCE = 0.5

let app: ElectronApplication | undefined
const dirs: string[] = []
test.afterEach(async () => {
  await closeTestApp(app)
  app = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('details pane content has normal inner padding', async () => {
  for (const theme of ['light', 'dark'] as const) {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-info-pad-')), profile = await mkdtemp(join(TMP, 'e2e-info-pad-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme, uiLanguage: 'en' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1360, 860) })
    if (!await page.evaluate(() => innerWidth === 1360 && innerHeight === 860)) await page.setViewportSize({ width: 1360, height: 860 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTestId('bot-vis-routine').click()
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
    const pane = page.getByTestId('bot-info-pane')
    await expect(pane.locator('textarea')).toBeVisible()
    await page.evaluate(() => Promise.all(document.getAnimations().map(one => one.finished.catch(() => undefined))))

    const m = await pane.evaluate(node => {
      const panel = node.querySelector('.bot-info-panel')!
      const items = [...panel.children, panel.querySelector('textarea'), panel.querySelector('.bots-memory')]
        .filter((el): el is Element => !!el && el.checkVisibility())
        .map(el => { const r = el.getBoundingClientRect(); return { name: `${el.tagName}.${el.className}${el.getAttribute('data-testid') ? `#${el.getAttribute('data-testid')}` : ''}`, left: r.left, right: r.right } })
      const pane = node.getBoundingClientRect()
      const radios = [...panel.querySelectorAll('input[type="radio"]')].at(-1)!.closest('label')!.getBoundingClientRect()
      const avatar = panel.querySelector('[data-testid="bot-info-avatar"]')!.getBoundingClientRect()
      return { pane: { left: pane.left, right: pane.right }, items, width: innerWidth, top: avatar.top, bottom: radios.bottom, bg: getComputedStyle(node).backgroundColor }
    })
    expect(Math.abs(m.pane.right - m.width), `PANE-PADDING ${theme}: pane right ${m.pane.right} vs window ${m.width}`).toBeLessThanOrEqual(1)
    expect(m.items.length).toBeGreaterThan(5)
    for (const item of m.items) {
      expect(item.right, `PANE-PADDING ${theme}: ${item.name} right ${item.right} vs pane right ${m.pane.right}`).toBeLessThanOrEqual(m.pane.right - GUTTER + TOLERANCE)
      expect(item.left, `PANE-PADDING ${theme}: ${item.name} left ${item.left} vs pane left ${m.pane.left}`).toBeGreaterThanOrEqual(m.pane.left + GUTTER - TOLERANCE)
    }

    const bg = (m.bg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const strip = await app.evaluate(async ({ BrowserWindow }, { right, top, bottom, width, strip, bg }) => {
      const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true })
      const size = image.getSize(), bitmap = image.toBitmap(), scale = size.width / width
      let worst = 0, at = ''
      for (let y = Math.ceil(top * scale); y < Math.floor(bottom * scale); y++) {
        for (let x = Math.ceil((right - strip) * scale); x < Math.floor(right * scale); x++) {
          const i = (y * size.width + x) * 4, rgb = [bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!]
          const off = Math.max(...rgb.map((c, k) => Math.abs(c - bg[k]!)))
          if (off > worst) { worst = off; at = `${x},${y} rgb(${rgb.join(',')})` }
        }
      }
      return { worst, at, png: image.toPNG().toString('base64') }
    }, { right: m.pane.right, top: m.top, bottom: m.bottom, width: m.width, strip: STRIP, bg })
    await test.info().attach(`details-pane-${theme}.png`, { body: Buffer.from(strip.png, 'base64'), contentType: 'image/png' })
    expect(strip.worst, `PANE-PADDING ${theme}: right ${STRIP}px strip not panel colour rgb(${bg.join(',')}) at ${strip.at}`).toBeLessThanOrEqual(6)
    await closeTestApp(app)
    app = undefined
  }
})
