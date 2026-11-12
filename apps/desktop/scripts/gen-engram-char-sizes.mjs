import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHAR_IDS = [
  '01-bean-tilt', '02-cloud', '03-cashew', '04-lobe', '05-squircle', '06-triangle', '07-oval', '08-knob',
  '09-pill', '10-comma', '11-peanut', '12-crescent', '13-donut', '14-drop', '15-hourglass', '16-diamond',
]
export const SIZES = [1024, 512, 256, 128, 64, 48, 40, 32, 24, 20, 16]
export const OPT_MAX = 24
export const MASTER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'assets', 'engram-chars')
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA { width, height, data }.
export function decodePng(buf, name = 'png') {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`${name}: not a PNG`)
  let width = 0, height = 0, bpp = 4
  const idat = []
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    if (at + 12 + len > buf.length) throw new Error(`${name}: truncated ${type} chunk`)
    const body = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || (body[9] !== 6 && body[9] !== 2) || body[12] !== 0) throw new Error(`${name}: must be 8-bit non-interlaced RGB(A)`)
      bpp = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!width || !idat.length) throw new Error(`${name}: missing IHDR or IDAT`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  if (raw.length !== height * (stride + 1)) throw new Error(`${name}: corrupt image data`)
  const rows = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? rows[row + i - bpp] : 0
      const b = y > 0 ? rows[row - stride + i] : 0
      const c = i >= bpp && y > 0 ? rows[row - stride + i - bpp] : 0
      let v = raw[src + i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (f !== 0) throw new Error(`${name}: bad filter ${f}`)
      rows[row + i] = v & 255
    }
  }
  if (bpp === 4) return { width, height, data: rows }
  const data = Buffer.alloc(width * height * 4, 255)
  for (let p = 0; p < width * height; p++) rows.copy(data, p * 4, p * 3, p * 3 + 3)
  return { width, height, data }
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(px, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(px, 0)
  ihdr.writeUInt32BE(px, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(px * (px * 4 + 1))
  for (let y = 0; y < px; y++) rgba.copy(raw, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4)
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// Area-average resample of a square straight-alpha RGBA image, in premultiplied space.
export function resample(img, px) {
  const n = img.width
  const out = Buffer.alloc(px * px * 4)
  const k = n / px
  for (let oy = 0; oy < px; oy++) {
    const y0 = oy * k, y1 = y0 + k
    for (let ox = 0; ox < px; ox++) {
      const x0 = ox * k, x1 = x0 + k
      let r = 0, g = 0, b = 0, a = 0, w = 0
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wt = wy * (Math.min(x + 1, x1) - Math.max(x, x0))
          const i = (y * n + x) * 4
          const al = img.data[i + 3] * wt
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; w += wt
        }
      }
      const o = (oy * px + ox) * 4
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
      out[o + 3] = Math.round(a / w)
    }
  }
  return { width: px, height: px, data: out }
}

// The regular face without its ground shadow: the optical master has the same silhouette and no shadow.
export function withoutShadow(regular, opt) {
  const data = Buffer.from(regular.data)
  for (let i = 3; i < data.length; i += 4) data[i] = Math.min(data[i], opt.data[i])
  return { ...regular, data }
}

const decodedBpp = (buf) => (buf[25] === 6 ? 4 : 3)

export function loadMaster(id, dir = MASTER_DIR) {
  const read = (file) => {
    const img = decodePng(readFileSync(join(dir, file)), file)
    if (img.width !== 1024 || img.height !== 1024) throw new Error(`${file}: master must be 1024x1024`)
    if (decodedBpp(readFileSync(join(dir, file))) !== 4) throw new Error(`${file}: master must be RGBA`)
    return img
  }
  const regular = read(`${id}.png`)
  const opt = read(`${id}@opt.png`)
  return { regular, opt, flat: withoutShadow(regular, opt) }
}

// Every file the generator writes, relative to the output directory.
export function expectedFiles() {
  return CHAR_IDS.flatMap((id) => [
    ...SIZES.map((s) => `avatar/${id}/${s}.png`),
    ...SIZES.filter((s) => s <= OPT_MAX).map((s) => `avatar/${id}/${s}@opt.png`),
  ])
}

// Writes avatar/{id}/{size}.png (and {size}@opt.png up to 24px) under outDir, replacing a prior set only once complete.
export function generate(outDir, masterDir = MASTER_DIR) {
  const target = resolve(outDir)
  const staging = `${target}.part-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const id of CHAR_IDS) {
      const { regular, opt, flat } = loadMaster(id, masterDir)
      const dir = join(staging, 'avatar', id)
      mkdirSync(dir, { recursive: true })
      for (const size of SIZES) {
        // Ground shadow only from 32px up; the small sizes keep the silhouette alone.
        const src = size > OPT_MAX ? regular : flat
        writeFileSync(join(dir, `${size}.png`), encodePng(size, resample(src, size).data))
        if (size <= OPT_MAX) writeFileSync(join(dir, `${size}@opt.png`), encodePng(size, resample(opt, size).data))
      }
    }
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return expectedFiles().map((file) => join(target, file))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: gen-engram-char-sizes.mjs <outDir>')
    process.exit(2)
  }
  console.log(`engram chars: ${generate(out).length} files in ${resolve(out)}`)
}
