import { Menu, Tray, nativeImage } from 'electron'

// The tray wears the app's own mark: the same little star, drawn at the two
// sizes a system tray asks for. It is one silhouette with the face cut out of
// it, so it reads as a character at 16px and stays a solid shape at 32.
// Geometry in the 24 grid the mark was drawn on, scaled to the icon.
const GRID = 24
const STAR = { cx: 12, cy: 12.6, R: 10.6, rIn: 7.0, puff: 0.58, tilt: (10 * Math.PI) / 180 }
const FACE = { cy: 12.0, gap: 3.0, r: 0.95, rSmall: 1.25 }
const SMILE = { cy: 11.5, rm: 2.1, t: 0.9, span: 0.62 }
// A mouth is a smudge on a 16px tray; the eyes alone carry it there.
const SMILE_MIN_PX = 32

// The body is star-convex about its centre, so "inside" is one radius per
// direction: the outline is sampled once into a direction -> radius table.
const LUT_BINS = 1024
const rimAt = (() => {
  const pol = (r: number, a: number) => ({ x: r * Math.sin(a), y: -r * Math.cos(a) })
  const q = (p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, t: number) => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  })
  const lut = new Float64Array(LUT_BINS)
  const step = (2 * Math.PI) / 5
  const { R, rIn, puff, tilt } = STAR
  const bulge = rIn + (R - rIn) * puff
  for (let i = 0; i < 5; i++) {
    const a = tilt + i * step
    const b = a + step / 2
    const tip = pol(R * 0.98, a)
    const inP = pol(rIn, b)
    const tip2 = pol(R * 0.98, a + step)
    for (let t = 0; t <= 300; t++) {
      for (const p of [q(tip, pol(bulge, a + step / 4), inP, t / 300), q(inP, pol(bulge, b + step / 4), tip2, t / 300)]) {
        const bin = Math.round(((Math.atan2(p.y, p.x) + Math.PI) / (2 * Math.PI)) * (LUT_BINS - 1))
        const r = Math.hypot(p.x, p.y)
        if (r > lut[bin]!) lut[bin] = r
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < LUT_BINS; k++) {
      if (lut[k] === 0) lut[k] = Math.max(lut[(k - 1 + LUT_BINS) % LUT_BINS]!, lut[(k + 1) % LUT_BINS]!)
    }
  }
  return (theta: number): number => {
    const at = ((theta + Math.PI) / (2 * Math.PI)) * LUT_BINS
    const k = Math.floor(at) % LUT_BINS
    const frac = at - Math.floor(at)
    return lut[k]! * (1 - frac) + lut[(k + 1) % LUT_BINS]! * frac
  }
})()

// The mark's coverage at one point, in grid units, face holes included.
function markAlpha(gx: number, gy: number, px: number): number {
  const dx = gx - STAR.cx
  const dy = gy - STAR.cy
  if (Math.hypot(dx, dy) > rimAt(Math.atan2(dy, dx))) return 0
  const detailed = px >= SMILE_MIN_PX
  const eyeR = detailed ? FACE.r : FACE.rSmall
  for (const side of [-1, 1]) {
    const ex = STAR.cx + side * FACE.gap
    if ((gx - ex) ** 2 + (gy - FACE.cy) ** 2 <= eyeR * eyeR) return 0
  }
  if (detailed) {
    const sr = Math.hypot(gx - STAR.cx, gy - SMILE.cy)
    const sa = Math.atan2(gx - STAR.cx, -(gy - SMILE.cy))
    if (Math.abs(sr - SMILE.rm) <= SMILE.t / 2 && Math.abs(sa) >= Math.PI - SMILE.span) return 0
    for (const side of [-1, 1]) {
      const capA = Math.PI + side * SMILE.span
      const capX = STAR.cx + SMILE.rm * Math.sin(capA)
      const capY = SMILE.cy - SMILE.rm * Math.cos(capA)
      if ((gx - capX) ** 2 + (gy - capY) ** 2 <= (SMILE.t / 2) ** 2) return 0
    }
  }
  return 1
}

function paintGlyph(scale: number): Buffer {
  const darwin = process.platform === 'darwin'
  const shade = darwin ? 0 : 255 // template black vs tray white
  const size = 16 * scale
  const SS = 4
  const buffer = Buffer.alloc(size * size * 4)
  // The mark fills the tray square, a hair inside it so nothing is clipped.
  const unit = size / GRID / 0.94
  const offX = size / 2 - STAR.cx * unit
  const offY = size / 2 - STAR.cy * unit
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = x + (sx + 0.5) / SS
          const v = y + (sy + 0.5) / SS
          acc += markAlpha((u - offX) / unit, (v - offY) / unit, size)
        }
      }
      const i = (y * size + x) * 4
      // BGRA
      buffer[i] = shade
      buffer[i + 1] = shade
      buffer[i + 2] = shade
      buffer[i + 3] = Math.round((acc / (SS * SS)) * 255)
    }
  }
  return buffer
}

function trayIcon() {
  const image = nativeImage.createFromBitmap(paintGlyph(1), { width: 16, height: 16 })
  // Retina menu bars pick the 2x representation instead of upscaling the 1x.
  image.addRepresentation({ buffer: paintGlyph(2), width: 32, height: 32, scaleFactor: 2 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

interface TrayActions {
  onOpen(): void
  onQuickCapture(): void
  onQuit(): void
  onInstallUpdate(): void
}

export interface TrayHandle {
  setUpdateReady(version: string): void
}

export function createTray(actions: TrayActions): TrayHandle {
  const tray = new Tray(trayIcon())
  let updateReady: string | undefined
  const build = (): void => {
    tray.setToolTip(updateReady ? `Engram — update ${updateReady} ready` : 'Engram')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(updateReady !== undefined
          ? [
              { label: `⟳ Restart to update (${updateReady})`, click: actions.onInstallUpdate },
              { type: 'separator' as const },
            ]
          : []),
        { label: 'Open Engram', click: actions.onOpen },
        { label: 'Quick capture', click: actions.onQuickCapture },
        { type: 'separator' },
        { label: 'Quit', click: actions.onQuit },
      ]),
    )
  }
  build()
  tray.on('click', actions.onOpen)
  return {
    setUpdateReady: (version) => {
      updateReady = version
      build()
    },
  }
}
