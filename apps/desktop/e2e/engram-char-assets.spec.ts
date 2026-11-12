import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TMP = join(ROOT, 'tmp')
const SHOTS = join(TMP, 'visual', 'rd-character-release-assets-r2a')
const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const IDS = [
  '01-bean-tilt', '02-cloud', '03-cashew', '04-lobe', '05-squircle', '06-triangle', '07-oval', '08-knob',
  '09-pill', '10-comma', '11-peanut', '12-crescent', '13-donut', '14-drop', '15-hourglass', '16-diamond',
]
const SHEET = join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(), '..', 'tmp', 'plans', 'engram-chars', 'plan', 'curated-16-sheet.png')

let app: ElectronApplication | undefined
const dirs: string[] = []

test.afterEach(async () => {
  await closeTestApp(app)
  app = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('16 curated characters and 08-knob app icon', async () => {
  await mkdir(SHOTS, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-chars-')), profile = await mkdtemp(join(TMP, 'e2e-chars-profile-')), sizes = await mkdtemp(join(TMP, 'e2e-chars-sizes-'))
  dirs.push(vault, profile, sizes)
  execFileSync(process.execPath, [join(DESKTOP, 'scripts', 'gen-engram-char-sizes.mjs'), join(sizes, 'out')])
  app = await electron.launch({ args: [join(DESKTOP, 'out', 'main', 'index.js'), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()

  const b64 = async (file: string) => (await readFile(file)).toString('base64')
  const masters = await Promise.all(IDS.map(id => b64(join(DESKTOP, 'src/renderer/src/assets/engram-chars', `${id}@opt.png`))))
  const small = await Promise.all(IDS.map(id => b64(join(sizes, 'out', 'avatar', id, '24@opt.png'))))
  const result = await page.evaluate(async ({ masters, small, sheet, icon }) => {
    const bitmap = (data: string) => createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }))
    const pixels = (img: ImageBitmap) => {
      const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height, { colorSpace: 'srgb' }).data
    }
    const at = (d: Uint8ClampedArray, i: number) => d[i] ?? 0
    const lum = (d: Uint8ClampedArray, i: number) => at(d, i) * 0.299 + at(d, i + 1) * 0.587 + at(d, i + 2) * 0.114
    const faces = []
    for (const data of small) {
      const img = await bitmap(data), d = pixels(img)
      let dark = 0, light = 0
      for (let i = 0; i < d.length; i += 4) if (at(d, i + 3) > 200) { if (lum(d, i) < 120) dark++; else if (lum(d, i) > 225) light++ }
      faces.push({ size: img.width, corner: at(d, 3), dark, light })
    }
    // Side by side: the curated sheet cell on the left, the optical master on the right, for every ID.
    const sheetImg = await bitmap(sheet)
    const board = document.createElement('canvas')
    board.width = 8 * 160; board.height = 4 * 160
    board.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#F6F3EE'
    document.body.append(board)
    const ctx = board.getContext('2d')!
    ctx.fillStyle = '#F6F3EE'; ctx.fillRect(0, 0, board.width, board.height)
    const alphas = []
    for (let k = 0; k < 16; k++) {
      const x = (k % 4) * 320, y = Math.floor(k / 4) * 160
      ctx.drawImage(sheetImg, (k % 4) * 300, Math.floor(k / 4) * 300, 300, 300, x, y, 160, 160)
      const m = await bitmap(masters[k] ?? '')
      ctx.drawImage(m, x + 160, y, 160, 160)
      const d = pixels(m)
      alphas.push([at(d, 3), at(d, (470 * 1024 + 512) * 4 + 3)])
    }
    const iconImg = await bitmap(icon), id = pixels(iconImg), W = iconImg.width
    const cols: number[] = []
    for (let x = 0; x < W; x++) for (let y = 0; y < W; y++) {
      const i = (y * W + x) * 4
      if (at(id, i + 3) === 255 && (Math.abs(at(id, i) - 0xf6) >= 4 || Math.abs(at(id, i + 2) - 0xee) >= 4)) { cols.push(x); break }
    }
    const p = (Math.floor(W / 2) * W + 1) * 4
    return { faces, alphas, plate: [at(id, p), at(id, p + 1), at(id, p + 2)], margins: [(cols[0] ?? 0) / W, (W - 1 - (cols.at(-1) ?? W)) / W] }
  }, { masters, small, sheet: await b64(SHEET), icon: await b64(join(DESKTOP, 'build', 'icon.png')) })

  for (const [k, face] of result.faces.entries()) {
    expect(face.size, IDS[k]).toBe(24)
    expect(face.corner, `${IDS[k]} transparent at 24px`).toBe(0)
    expect(face.dark, `${IDS[k]} eyes and smile at 24px`).toBeGreaterThanOrEqual(4)
    expect(face.light, `${IDS[k]} cream body at 24px`).toBeGreaterThan(face.dark)
  }
  for (const [k, [corner, body]] of result.alphas.entries()) expect([corner, body], IDS[k]).toEqual([0, 255])
  expect(result.plate).toEqual([0xf6, 0xf3, 0xee])
  for (const margin of result.margins) {
    expect(margin).toBeGreaterThanOrEqual(0.12)
    expect(margin).toBeLessThanOrEqual(0.14)
  }
  await page.locator('canvas').last().screenshot({ path: join(SHOTS, 'side-by-side.png') })
})
