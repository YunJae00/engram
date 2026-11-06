import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function pageScene(x, y, width, height) {
  if (y < height * 0.12) return [24, 40, 72]
  if (x > width * 0.1 && x < width * 0.5 && y > height * 0.25 && y < height * 0.6) return [220, 60, 60]
  if (x > width * 0.6 && x < width * 0.9 && y > height * 0.7 && y < height * 0.85) return [40, 90, 220]
  return [248, 250, 252]
}

export function pngFrame({ width = 1280, height = 800, paint = pageScene } = {}) {
  const raw = Buffer.alloc((1 + width * 3) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y, width, height)
      raw.set([r, g, b], row + 1 + x * 3)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const png = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return { data: png.toString('base64'), width, height }
}

export function sendEvents(app, events) {
  return app.evaluate(({ BrowserWindow }, events) => {
    const win = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('index.html'))
    if (!win) throw new Error('no app window to send events to')
    for (const event of events) win.webContents.send('engram:event', event)
  }, events)
}

export function showWebFrame(app, { lane, url, frame, title = 'Live overlay' }) {
  return sendEvents(app, [
    { type: 'comet:working', channel: lane, working: true },
    { type: 'comet:step', channel: lane, line: `read_open_page: ${title}` },
    { type: 'agent:live', on: true, url, lane },
    { type: 'agent:frame', lane, url, data: frame.data, width: frame.width, height: frame.height },
  ])
}

export function appFrames(lane, ids, frame, extra = {}) {
  const frames = ids.map(id => ({ id: `${lane}:app:${id}`, lane, title: id, at: Date.now(), data: `data:image/png;base64,${frame.data}`, captureState: 'ready', ...extra }))
  return { type: 'desktop:preview', frames }
}
