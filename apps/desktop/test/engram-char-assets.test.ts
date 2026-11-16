import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ORBS } from '../../../packages/core/src/bot-character.js'
import { decodePng, encodePng, resample } from '../scripts/gen-engram-char-sizes.mjs'
import { rasterize } from '../scripts/svg-raster.mjs'

type Img = { width: number; height: number; data: Buffer }

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BUILD = new URL('../build/', import.meta.url)
const RENDERER = new URL('../src/renderer/src/', import.meta.url)
const SIZES = [1024, 512, 256, 128, 64, 48, 40, 32, 24, 20, 16]
const SMALL_MAX = 48

const lum = (img: Img, i: number) => (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000
const violet = (img: Img, i: number) => img.data[i + 3] === 255 && img.data[i + 2] >= 60 && img.data[i + 2] - img.data[i + 1] >= 20 && img.data[i] >= img.data[i + 1]
const master = (file: string) => rasterize(readFileSync(new URL(file, BUILD), 'utf8')) as Img
const regular = master('icon.svg')
const small = master('icon-small.svg')

function icoEntry(size: number): Img {
  const ico = readFileSync(new URL('icon.ico', BUILD))
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16
    if ((ico[entry] || 256) !== size) continue
    const offset = ico.readUInt32LE(entry + 12)
    return decodePng(ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)), `ico ${size}`)
  }
  throw new Error(`icon.ico has no ${size}px entry`)
}

function figures(img: Img) {
  const n = img.width
  const seen = new Uint8Array(n * n)
  let count = 0
  for (let s = 0; s < n * n; s++) {
    if (seen[s] || img.data[s * 4 + 3] < 128) continue
    count++
    const stack = [s]; seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!, x = p % n
      for (const q of [x + 1 < n ? p + 1 : -1, x > 0 ? p - 1 : -1, p + n, p - n]) {
        if (q >= 0 && q < n * n && !seen[q] && img.data[q * 4 + 3] >= 128) { seen[q] = 1; stack.push(q) }
      }
    }
  }
  return count
}

describe('orb and icon masters', () => {
  it('pins the 8 orb ids in order, with no character PNG left in the repo', () => {
    expect(ORBS).toEqual(['orb-violet', 'orb-blue', 'orb-teal', 'orb-green', 'orb-amber', 'orb-rose', 'orb-lilac', 'orb-silver'])
    expect(existsSync(new URL('assets/engram-chars', RENDERER))).toBe(false)
    expect(execFileSync('git', ['ls-files', '--', 'apps/desktop/src/renderer/src/assets/engram-chars'], { cwd: ROOT, encoding: 'utf8' }).trim()).toBe('')
  })

  it('rasterizes transparent 1024 RGBA icon masters with a single body and dark edges', () => {
    for (const [name, img] of [['icon.svg', regular], ['icon-small.svg', small]] as const) {
      expect([img.width, img.height, img.data.length], name).toEqual([1024, 1024, 1024 * 1024 * 4])
      const a = (x: number, y: number) => img.data[(y * 1024 + x) * 4 + 3]
      for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023]]) expect(a(x, y), `${name} corner`).toBe(0)
      for (const [x, y] of [[512, 512], [512, 0], [0, 512], [1023, 512], [512, 1023]]) expect(a(x, y), `${name} body`).toBe(255)
      expect(figures(img), `${name} figures`).toBe(1)
      let fringe = 0
      for (let i = 0; i < img.data.length; i += 4) {
        const al = img.data[i + 3]
        if (al > 0 && al < 255 && lum(img, i) > 24) fringe++
      }
      expect(fringe, `${name} light fringe on the rounded edge`).toBe(0)
    }
  })

  it('keeps one silhouette for both masters: the small one only thickens the arc and widens the bloom', () => {
    let alphaDiff = 0, lit = 0, litSmall = 0
    for (let i = 0; i < regular.data.length; i += 4) {
      if (regular.data[i + 3] !== small.data[i + 3]) alphaDiff++
      if (violet(regular, i)) lit++
      if (violet(small, i)) litSmall++
    }
    expect(alphaDiff).toBe(0)
    expect(lit).toBeGreaterThan(1000)
    expect(litSmall).toBeGreaterThan(lit * 1.5)
  })

  it('gives every orb its own color rule in bot-orb.css', () => {
    const css = readFileSync(new URL('bot-orb.css', RENDERER), 'utf8')
    const colors = ORBS.map(orb => {
      const rule = new RegExp(`\\[data-orb='${orb}'\\]\\s*\\{[^}]*--orb:\\s*(#[0-9A-Fa-f]{6})`).exec(css)
      expect(rule, orb).not.toBeNull()
      return rule![1]!.toLowerCase()
    })
    expect(new Set(colors).size).toBe(ORBS.length)
    expect(css).not.toMatch(/url\(|\.png/)
  })
})

describe('icon sizes', () => {
  it('encodes and decodes every size losslessly with transparent corners', () => {
    for (const size of SIZES) {
      const img = resample(size <= SMALL_MAX ? small : regular, size) as Img
      const back = decodePng(encodePng(size, img.data), `${size}`) as Img
      expect([back.width, back.height], `${size}`).toEqual([size, size])
      expect(back.data.equals(img.data), `${size} round trip`).toBe(true)
      expect(back.data[3], `${size} corner`).toBe(0)
      expect(back.data[((size >> 1) * size + (size >> 1)) * 4 + 3], `${size} centre`).toBe(255)
    }
  })

  it('uses the small master at 48px and below and the regular one from 64px', () => {
    for (const size of [16, 24, 32, 48]) {
      expect(icoEntry(size).data.equals((resample(small, size) as Img).data), `${size} small`).toBe(true)
      expect(icoEntry(size).data.equals((resample(regular, size) as Img).data), `${size} not regular`).toBe(false)
    }
    for (const size of [64, 128, 256]) expect(icoEntry(size).data.equals((resample(regular, size) as Img).data), `${size} regular`).toBe(true)
  })

  it('keeps a violet arc with a brighter bloom at its centre on the 24px icon', () => {
    const img = icoEntry(24)
    const row = Array.from({ length: 24 }, (_, y) => Math.max(...Array.from({ length: 24 }, (_, x) => lum(img, (y * 24 + x) * 4))))
    const y = row.indexOf(Math.max(...row))
    expect(y / 24).toBeGreaterThanOrEqual(0.4)
    expect(y / 24).toBeLessThanOrEqual(0.75)
    const across = Array.from({ length: 24 }, (_, x) => Math.max(lum(img, ((y - 1) * 24 + x) * 4), lum(img, (y * 24 + x) * 4), lum(img, ((y + 1) * 24 + x) * 4)))
    const peak = across.indexOf(Math.max(...across))
    expect(peak === 11 || peak === 12, 'bloom sits at the centre').toBe(true)
    expect(across[peak]! - across[4]!, 'bloom is brighter than the arc').toBeGreaterThan(25)
    expect(across.filter(v => v >= 40).length, 'arc spans the tile').toBeGreaterThanOrEqual(8)
    let count = 0
    for (let i = 0; i < img.data.length; i += 4) if (violet(img, i)) count++
    expect(count).toBeGreaterThanOrEqual(6)
    expect(Math.max(...row.slice(0, 6)), 'no highlight above').toBeLessThan(40)
  })

  it('fails loudly on a bad SVG or PNG instead of drawing something else', () => {
    expect(() => rasterize('<svg viewBox="0 0 8 8"><rect id="body" width="8" height="8" fill="#000000"/><text>a</text></svg>')).toThrow(/unsupported/)
    expect(() => rasterize('<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="2" fill="#ffffff"/></svg>')).toThrow(/body/)
    expect(() => rasterize('not an svg')).toThrow(/unsupported content/)
    expect(() => decodePng(Buffer.from('not a png'), 'bad')).toThrow('bad: not a PNG')
    const png = encodePng(16, (resample(small, 16) as Img).data)
    expect(() => decodePng(png.subarray(0, png.length - 20), 'cut')).toThrow(/cut: (truncated|corrupt|missing)/)
  })
})
