import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TMP = join(ROOT, 'tmp')
const SHOTS = join(TMP, 'visual', 'rd-character-release-assets-r2a')
const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const CATALOG = join(DESKTOP, 'build', 'Engram.xcassets', 'AppIcon.appiconset')
const OLD_FACE = /bean-tilt|cashew|squircle|08-knob|hourglass|16-diamond|@opt/

let app: ElectronApplication | undefined
const dirs: string[] = []

test.afterEach(async () => {
  await closeTestApp(app)
  app = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('no character masters ship and the app icon is two light arcs on a dark plate', async () => {
  await mkdir(SHOTS, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-chars-')), profile = await mkdtemp(join(TMP, 'e2e-chars-profile-'))
  dirs.push(vault, profile)
  expect(existsSync(join(DESKTOP, 'src/renderer/src/assets/engram-chars'))).toBe(false)
  const shipped = await readdir(join(DESKTOP, 'out', 'renderer'), { recursive: true })
  expect(shipped.length).toBeGreaterThan(0)
  expect(shipped.filter(file => OLD_FACE.test(file))).toEqual([])

  app = await electron.launch({ args: [join(DESKTOP, 'out', 'main', 'index.js'), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()

  const b64 = async (file: string) => (await readFile(file)).toString('base64')
  const files = ['icon_16x16.png', 'icon_16x16@2x.png', 'icon_32x32@2x.png', 'icon_128x128.png', 'icon_256x256.png']
  const result = await page.evaluate(async ({ icon, catalog }) => {
    const bitmap = (data: string) => createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }), { premultiplyAlpha: 'none' })
    const pixels = (img: ImageBitmap) => {
      const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height, { colorSpace: 'srgb' }).data
    }
    const at = (d: Uint8ClampedArray, i: number) => d[i] ?? 0
    const lum = (d: Uint8ClampedArray, i: number) => at(d, i) * 0.299 + at(d, i + 1) * 0.587 + at(d, i + 2) * 0.114
    const measure = (img: ImageBitmap) => {
      const d = pixels(img), W = img.width
      let warm = 0, cool = 0, low = 255, high = 0
      // The brightest opaque pixel of each row, to find the crest of the arc in each half.
      const rows = new Array<number>(W).fill(0)
      for (let i = 0; i < d.length; i += 4) {
        if (at(d, i + 3) !== 255) continue
        const v = lum(d, i)
        low = Math.min(low, v)
        high = Math.max(high, v)
        const y = Math.floor(i / 4 / W)
        rows[y] = Math.max(rows[y] ?? 0, v)
        // The peach fringe outside the circle and the blue one inside it.
        if (at(d, i) >= 120 && at(d, i) - at(d, i + 2) >= 30) warm++
        if (at(d, i + 2) >= 120 && at(d, i + 2) - at(d, i) >= 30) cool++
      }
      const side = (Math.floor(W / 2) * W + 1) * 4, centre = (Math.floor(W / 2) * W + Math.floor(W / 2)) * 4
      // Each arc's crest: its brightness and how far it sits from the centre, as a share of the width.
      const crests = [rows.slice(0, W / 2), rows.slice(W / 2)].map((half, k) => {
        const peak = Math.max(...half)
        return { lum: peak, off: Math.abs((k * W) / 2 + half.indexOf(peak) + 0.5 - W / 2) / W }
      })
      return { W, corner: at(d, 3), sideAlpha: at(d, side + 3), sideLum: lum(d, side), centreLum: lum(d, centre), warm, cool, range: high - low, crests }
    }
    const board = document.createElement('canvas')
    board.width = (catalog.length + 1) * 160; board.height = 160
    board.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#F6F3EE'
    document.body.append(board)
    const ctx = board.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#F6F3EE'; ctx.fillRect(0, 0, board.width, board.height)
    const iconImg = await bitmap(icon)
    ctx.drawImage(iconImg, 8, 8, 144, 144)
    const sets = []
    for (const [k, data] of catalog.entries()) {
      const img = await bitmap(data)
      ctx.drawImage(img, (k + 1) * 160 + 8, 8, 144, 144)
      sets.push(measure(img))
    }
    return { icon: measure(iconImg), sets }
  }, { icon: await b64(join(DESKTOP, 'build', 'icon.png')), catalog: await Promise.all(files.map(file => b64(join(CATALOG, file)))) })

  expect(result.icon.W).toBe(512)
  expect(result.icon.corner).toBe(0)
  expect(result.icon.sideAlpha).toBe(255)
  // The plate is dark but grainy, so one pixel is not flat black; the icon unit test holds the plate to the same bound.
  expect(result.icon.sideLum).toBeLessThan(60)
  expect(result.icon.centreLum, 'dark plate between the arcs').toBeLessThan(60)
  expect(result.icon.warm, 'peach fringe').toBeGreaterThanOrEqual(512 * 512 * 0.004)
  expect(result.icon.cool, 'blue fringe').toBeGreaterThanOrEqual(512 * 512 * 0.004)
  const arcs = (name: string, set: (typeof result)['icon']) => {
    expect(set.crests, `${name} one arc above the centre and one below`).toHaveLength(2)
    for (const [k, crest] of set.crests.entries()) {
      const arc = `${name} ${k === 0 ? 'top' : 'bottom'} arc`
      expect(crest.lum, `${arc} white core`).toBeGreaterThanOrEqual(200)
      expect(crest.off, `${arc} sits on the circle`).toBeGreaterThanOrEqual(0.2)
      expect(crest.off, `${arc} sits on the circle`).toBeLessThanOrEqual(0.4)
    }
  }
  arcs('icon.png', result.icon)
  for (const [k, set] of result.sets.entries()) {
    expect(set.corner, `${files[k]} transparent margin`).toBe(0)
    expect(set.range, `${files[k]} is not a flat tile`).toBeGreaterThanOrEqual(70)
    expect(set.centreLum, `${files[k]} dark plate between the arcs`).toBeLessThan(60)
    arcs(files[k]!, set)
    // 16px is drawn from the small master: heavier white arcs, too few pixels to hold a fringe.
    if (set.W > 16) {
      expect(set.warm, `${files[k]} peach fringe`).toBeGreaterThanOrEqual(3)
      expect(set.cool, `${files[k]} blue fringe`).toBeGreaterThanOrEqual(3)
    }
  }
  await page.locator('canvas').last().screenshot({ path: join(SHOTS, 'side-by-side.png') })
})
