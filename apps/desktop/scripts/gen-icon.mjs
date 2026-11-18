import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng, resample } from './gen-engram-char-sizes.mjs'
import { rasterize } from './svg-raster.mjs'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const master = (file) => rasterize(readFileSync(join(dir, file), 'utf8'))
const regular = master('icon.svg')
const small = master('icon-small.svg')
const SMALL_MAX = 48

const renderIcon = (px) => resample(px <= SMALL_MAX ? small : regular, px).data

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  const blobs = []
  let offset = 6 + entries.length * 16
  for (const { px, png } of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = px >= 256 ? 0 : px
    dir[1] = px >= 256 ? 0 : px
    dir[2] = 0
    dir[3] = 0
    dir.writeUInt16LE(1, 4)
    dir.writeUInt16LE(32, 6)
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    dirs.push(dir)
    blobs.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}

const MAC_CANVAS = 1024
const MAC_BODY = 824

function padCanvas(rgba, srcPx, dstPx) {
  const out = Buffer.alloc(dstPx * dstPx * 4)
  const offset = Math.round((dstPx - srcPx) / 2)
  for (let y = 0; y < srcPx; y++) {
    rgba.copy(out, ((y + offset) * dstPx + offset) * 4, y * srcPx * 4, (y + 1) * srcPx * 4)
  }
  return out
}

const APPICON_SIZES = [16, 32, 128, 256, 512]
const icoSizes = [256, 128, 64, 48, 32, 24, 16]

const png512 = encodePng(512, renderIcon(512))
const mac = encodePng(MAC_CANVAS, padCanvas(renderIcon(MAC_BODY), MAC_BODY, MAC_CANVAS))
const ico = encodeIco(icoSizes.map((px) => ({ px, png: encodePng(px, renderIcon(px)) })))
const catalog = APPICON_SIZES.flatMap((size) => [1, 2].map((scale) => {
  const px = size * scale
  const body = Math.round((px * MAC_BODY) / MAC_CANVAS)
  return { size, scale, file: `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`, png: encodePng(px, padCanvas(renderIcon(body), body, px)) }
}))

const set = join(dir, 'Engram.xcassets', 'AppIcon.appiconset')
mkdirSync(set, { recursive: true })
writeFileSync(join(dir, 'icon.png'), png512)
writeFileSync(join(dir, 'icon-mac.png'), mac)
writeFileSync(join(dir, 'icon.ico'), ico)
for (const { file, png } of catalog) writeFileSync(join(set, file), png)
const images = catalog.map(({ size, scale, file }) => ({ size: `${size}x${size}`, idiom: 'mac', filename: file, scale: `${scale}x` }))
writeFileSync(join(set, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'engram' } }, null, 2))
console.log(
  `icons written: icon.png (${png512.length} bytes) + icon-mac.png (${mac.length} bytes, ${MAC_BODY}/${MAC_CANVAS} grid) + icon.ico (${ico.length} bytes, ${icoSizes.join('/')}px) + ${set}`,
)
