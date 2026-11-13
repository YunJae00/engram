import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAR_IDS, MASTER_DIR, decodePng, expectedFiles, generate, loadMaster, resample } from '../scripts/gen-engram-char-sizes.mjs'

type Img = { width: number; height: number; data: Buffer }

const IDS = [
  '01-bean-tilt', '02-cloud', '03-cashew', '04-lobe', '05-squircle', '06-triangle', '07-oval', '08-knob',
  '09-pill', '10-comma', '11-peanut', '12-crescent', '13-donut', '14-drop', '15-hourglass', '16-diamond',
]
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = join(ROOT, 'tmp', `engram-char-assets-${process.pid}`)
const plans = join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(), '..', 'tmp', 'plans', 'engram-chars', 'plan')
const SHEET = join(plans, 'curated-16-sheet.png')

const lum = (img: Img, i: number) => (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000
const read = (file: string): Img => decodePng(readFileSync(file), file)

// Square boolean mask of a figure: cropped to its bounding box, fitted into n×n keeping aspect.
function fitted(width: number, height: number, inside: (x: number, y: number) => boolean, n = 48) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1)
  const ox = x0 - (side - (x1 - x0 + 1)) / 2, oy = y0 - (side - (y1 - y0 + 1)) / 2
  const out: boolean[] = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = Math.floor(ox + ((x + 0.5) * side) / n), sy = Math.floor(oy + ((y + 0.5) * side) / n)
    out.push(sx >= 0 && sy >= 0 && sx < width && sy < height && inside(sx, sy))
  }
  return out
}

const iou = (a: boolean[], b: boolean[]) => {
  let both = 0, either = 0
  a.forEach((v, i) => { if (v && b[i]) both++; if (v || b[i]) either++ })
  return both / either
}

function components(width: number, height: number, on: (x: number, y: number) => boolean) {
  const seen = new Uint8Array(width * height)
  const found: { n: number; x0: number; y0: number; x1: number; y1: number }[] = []
  for (let s = 0; s < width * height; s++) {
    if (seen[s] || !on(s % width, Math.floor(s / width))) continue
    const stack = [s]; seen[s] = 1
    const c = { n: 0, x0: width, y0: height, x1: -1, y1: -1 }
    while (stack.length) {
      const p = stack.pop()!, x = p % width, y = Math.floor(p / width)
      c.n++; c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y)
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const q = ny * width + nx
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[q] && on(nx, ny)) { seen[q] = 1; stack.push(q) }
      }
    }
    found.push(c)
  }
  return found.sort((a, b) => b.n - a.n)
}

const masters = new Map(IDS.map(id => [id, loadMaster(id) as { regular: Img; opt: Img; flat: Img }]))
afterAll(() => rmSync(OUT, { recursive: true, force: true }))

describe('engram character masters', () => {
  it('pins the 16 curated IDs in order, with no letter, pretzel, plus or star form', () => {
    expect(CHAR_IDS).toEqual(IDS)
    expect(IDS.join(' ')).not.toMatch(/letter|pretzel|plus|star/)
  })

  it('ships transparent 1024 RGBA masters with a single figure and clean cream edges', () => {
    for (const id of IDS) {
      for (const file of [`${id}.png`, `${id}@opt.png`]) {
        const buf = readFileSync(join(MASTER_DIR, file))
        expect(buf[25], file).toBe(6)
        const img = read(join(MASTER_DIR, file))
        expect([img.width, img.height]).toEqual([1024, 1024])
        const a = (x: number, y: number) => img.data[(y * 1024 + x) * 4 + 3]
        for (let k = 0; k < 1024; k++) for (const [x, y] of [[k, 0], [k, 1023], [0, k], [1023, k]]) expect(a(x, y), `${file} border`).toBe(0)
        expect(a(512, 470), `${file} body`).toBe(255)
        const figures = components(1024, 1024, (x, y) => a(x, y) >= 128).filter(c => c.n > 50).length
        expect(figures, `${file} figures`).toBe(file.includes('@opt') ? 1 : Math.min(figures, 2))
        expect(figures).toBeGreaterThanOrEqual(1)
        let fringe = 0
        for (let i = 0; i < img.data.length; i += 4) {
          const al = img.data[i + 3]
          if (al > 0 && al < 255 && (lum(img, i) < 200 || img.data[i] < img.data[i + 2])) fringe++
        }
        expect(fringe, `${file} JPEG or dark fringe`).toBe(0)
      }
    }
  })

  it('keeps one silhouette per ID: optical only resizes the face, the shadow is a flat warm oval below', () => {
    const masks = IDS.map(id => {
      const { regular, opt } = masters.get(id)!
      let below = 0, extra = 0
      const tones: number[] = []
      let lost = 0
      for (let i = 3; i < opt.data.length; i += 4) {
        if (opt.data[i] >= 128 && regular.data[i] < 128) lost++
        if (regular.data[i] === 255 && opt.data[i] === 0) {
          extra++
          if (Math.floor(i / 4 / 1024) > 600) below++
          tones.push(regular.data[i - 3] * 256 + regular.data[i - 1])
        }
      }
      expect(lost, `${id} regular keeps the optical body`).toBe(0)
      expect(extra, `${id} has a ground shadow`).toBeGreaterThan(1000)
      const tone = tones.sort((a, b) => a - b)[tones.length >> 1]
      expect([tone >> 8, tone & 255], `${id} shadow is flat warm #E4E0DB`).toEqual([0xe4, 0xdb])
      expect(below / extra, `${id} shadow sits below the body`).toBe(1)
      const shape = fitted(1024, 1024, (x, y) => opt.data[(y * 1024 + x) * 4 + 3] >= 128)
      const flat = fitted(1024, 1024, (x, y) => masters.get(id)!.flat.data[(y * 1024 + x) * 4 + 3] >= 128)
      expect(iou(shape, flat), `${id} optical silhouette`).toBeGreaterThan(0.99)
      return shape
    })
    for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) expect(iou(masks[i], masks[j]), `${IDS[i]} vs ${IDS[j]}`).toBeLessThan(0.93)
  })

  // The curated sheet lives in gitignored tmp/, so CI runners do not have it.
  it.skipIf(!existsSync(SHEET))('matches the curated sheet silhouette for every ID, side by side', () => {
    // The sheet is a 4×4 grid of 300px cells; a body pixel is warmer than the warm-white paper or darker than it.
    const sheet = read(SHEET)
    const cells = IDS.map((_, k) => {
      const cx = (k % 4) * 300, cy = Math.floor(k / 4) * 300
      return fitted(300, 300, (x, y) => {
        const i = ((cy + y) * 1200 + cx + x) * 4
        return sheet.data[i] - sheet.data[i + 2] >= 7 || lum(sheet, i) < 200
      })
    })
    IDS.forEach((id, k) => {
      const opt = masters.get(id)!.opt
      const ours = fitted(1024, 1024, (x, y) => opt.data[(y * 1024 + x) * 4 + 3] >= 128)
      const scores = cells.map(cell => iou(ours, cell))
      // Tolerance covers the sheet's soft lower edge and the donut's inner shading; the face never changes the outline.
      expect(scores[k], `${id} overlap`).toBeGreaterThan(0.8)
      expect(scores.indexOf(Math.max(...scores)), `${id} best match`).toBe(k)
    })
  })
})

describe('engram character sizes', () => {
  const files = generate(OUT)

  it('writes avatar/{id}/{size}.png at every size and {size}@opt.png at 24px and below', () => {
    expect(files).toHaveLength(16 * 11 + 16 * 3)
    expect(expectedFiles()).toContain('avatar/13-donut/24@opt.png')
    for (const rel of expectedFiles()) {
      const size = Number.parseInt(rel.split('/')[2])
      const img = read(join(OUT, rel))
      expect([img.width, img.height], rel).toEqual([size, size])
      expect(img.data[3], rel).toBe(0)
    }
  })

  it('drops the ground shadow at 16 to 24px and keeps it from 32px', () => {
    for (const id of IDS) {
      for (const size of [16, 20, 24]) {
        const plain = read(join(OUT, `avatar/${id}/${size}.png`))
        const flat = resample(masters.get(id)!.flat, size) as Img
        expect(plain.data.equals(flat.data), `${id} ${size}`).toBe(true)
      }
      const big = read(join(OUT, `avatar/${id}/32.png`))
      const bare = resample(masters.get(id)!.flat, 32) as Img
      expect(big.data.equals(bare.data), `${id} 32 keeps shadow`).toBe(false)
    }
  })

  it('keeps two oval eyes with an upper-right highlight and a smile on every 24px optical face', () => {
    for (const id of IDS) {
      const img = read(join(OUT, `avatar/${id}/24@opt.png`))
      // Eye pixels: clearly darker than the cream body; the two topmost such blobs are the eyes, the smile sits below.
      const dark = (x: number, y: number) => img.data[(y * 24 + x) * 4 + 3] > 200 && lum(img, (y * 24 + x) * 4) < 190
      const eyes = components(24, 24, dark).filter(c => c.n >= 3).sort((a, b) => a.y0 - b.y0).slice(0, 2).sort((a, b) => a.x0 - b.x0)
      expect(eyes, `${id} eyes`).toHaveLength(2)
      for (const e of eyes) {
        const w = e.x1 - e.x0 + 1, h = e.y1 - e.y0 + 1
        expect(h / w, `${id} eye is an oval, not a bar`).toBeLessThan(2.5)
        let core = 255, hi = 0
        for (let y = e.y0; y <= e.y1; y++) for (let x = e.x0; x <= e.x1; x++) {
          const v = lum(img, (y * 24 + x) * 4)
          if (x - e.x0 >= w / 2 - 0.5 && y - e.y0 <= h / 2) hi = Math.max(hi, v)
          core = Math.min(core, v)
        }
        expect(hi - core, `${id} highlight upper-right`).toBeGreaterThan(25)
      }
      const bottom = Math.max(eyes[0].y1, eyes[1].y1)
      let smile = 0
      for (let y = bottom + 1; y < 24; y++) for (let x = eyes[0].x1; x <= eyes[1].x0; x++) {
        const i = (y * 24 + x) * 4
        if (img.data[i + 3] > 200 && lum(img, i) < 190) smile++
      }
      expect(smile, `${id} smile`).toBeGreaterThanOrEqual(2)
    }
  })

  it('fails loudly on a missing or non-RGBA master and keeps the previous output', () => {
    const bad = join(ROOT, 'tmp', `engram-char-bad-${process.pid}`)
    mkdirSync(bad, { recursive: true })
    expect(() => generate(OUT, bad)).toThrow(/01-bean-tilt\.png|ENOENT/)
    expect(read(join(OUT, 'avatar/08-knob/16@opt.png')).width).toBe(16)
    rmSync(bad, { recursive: true, force: true })
  })
})
