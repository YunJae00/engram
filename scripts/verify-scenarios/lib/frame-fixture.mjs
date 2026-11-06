import { deflateSync } from 'node:zlib'
/* global document, window, PointerEvent, innerWidth, innerHeight */

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

export function appPreview(lane, frames, image, at = Date.now()) {
  return { type: 'desktop:preview', frames: frames.map((one) => {
    const { id, ...rest } = typeof one === 'string' ? { id: one } : one
    return { id, lane, title: id, at, data: `data:image/png;base64,${image.data}`, captureState: 'ready', ...rest }
  }) }
}

// A window that was never shown acks each pointer event about a second late on Linux, so it is shown before any input.
export async function sizeWindow(app, page, expect, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.showInactive()
    win.setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(([width, height]) => innerWidth === width && Math.abs(innerHeight - height) < 60, [width, height])).toBe(true)
}

// A test-only inline limit on the chat height; an empty value removes it.
export function constrainChat(page, maxHeight) {
  return page.evaluate((value) => { document.querySelector('.bots-chat').style.maxHeight = value }, maxHeight)
}

export async function expectPainted(card, frame, expect) {
  await expect(card).toBeVisible()
  await expect(card.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 15_000 })
  await expect(card.locator('canvas')).toHaveAttribute('data-format', 'png')
  await expect(card.locator('.preview-card-label')).toContainText('example.test')
  expect(await card.locator('canvas').evaluate((canvas) => [canvas.width, canvas.height])).toEqual([frame.width, frame.height])
  expect(await card.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(256, 320, 1, 1).data])).toEqual([220, 60, 60, 255])
}

export async function grab(page, card) {
  const box = await card.boundingBox()
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  return at
}

export async function dragTo(page, card, to, steps = 6) {
  const from = await grab(page, card)
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
  return from
}

export async function dragBy(page, card, dx, dy, steps = 4) {
  const box = await card.boundingBox()
  return dragTo(page, card, { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy }, steps)
}

export async function dragAcross(page, card, unchanged) {
  const box = await card.boundingBox()
  const from = await grab(page, card)
  const to = { x: from.x - box.width, y: from.y + box.height }
  await page.mouse.move(from.x - box.width * 0.3, from.y, { steps: 6 })
  await unchanged()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await unchanged()
  await page.mouse.up()
  return { from, to }
}

// Cancellations the mouse cannot produce are injected on the deck with the pointer id it recorded.
export function cancelDrag(page, deck, kind, id) {
  if (kind === 'blur') return page.evaluate(() => window.dispatchEvent(new Event('blur')))
  if (kind === 'Escape') return page.keyboard.press('Escape')
  if (kind === 'lostpointercapture') return deck.evaluate((node, id) => node.releasePointerCapture(id), id)
  return deck.evaluate((node, [type, id]) => node.dispatchEvent(new PointerEvent(type, { pointerId: id, bubbles: true })), [kind, id])
}

export function secondPointer(deck, pointerId) {
  return deck.evaluate((node, pointerId) => {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) node.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: false, button: 0, buttons: 1, clientX: 40, clientY: 40, bubbles: true }))
  }, pointerId)
}

export async function withRefusedCapture(deck, run) {
  await deck.evaluate(node => { node.setPointerCapture = () => { throw new Error('capture refused') } })
  try { await run() } finally { await deck.evaluate(node => { delete node.setPointerCapture }) }
}

export async function toggleSidebar(page, open) {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === String(open)) await page.getByTestId(open ? 'app-sidebar-open' : 'app-sidebar-close').click()
}

// Leaves the comets activity through the workspace menu without releasing the mouse button.
export async function switchAway(page) {
  await page.getByTestId('workspace-switcher').evaluate(node => node.click())
  await page.getByTestId('activity-list').evaluate(node => node.click())
}
