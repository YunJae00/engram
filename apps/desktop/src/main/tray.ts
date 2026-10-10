import { Menu, Tray, nativeImage } from 'electron'

// The tray wears the app's own mark: the comet, drawn at the two sizes a
// system tray asks for. One silhouette, so it reads at 16px and stays a solid
// shape at 32. Same numbers as the app icon (scripts/gen-icon.mjs) and the
// in-app mark (Icon.tsx), in the 24 grid they were drawn on.
const STAR = { cx: 13.9, cy: 10.1, R: 5.25, r: 3.2, sw: 2.25, tilt: (12 * Math.PI) / 180 }
const TRAIL: readonly (readonly [number, number, number])[] = [
  [8.6, 15.4, 1.6],
  [5.8, 18.0, 1.15],
  [3.75, 20.05, 0.75],
]
// The mark's bounding box in grid units, used to fit it to the tray square.
const MARK_BOX = { cx: 11.65, cy: 12.25, size: 17.3 }

const VERTS: readonly (readonly [number, number])[] = Array.from({ length: 10 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 5 + STAR.tilt
  const rad = k % 2 === 0 ? STAR.R : STAR.r
  return [STAR.cx + rad * Math.cos(a), STAR.cy + rad * Math.sin(a)] as const
})

function inPoly(x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = VERTS.length - 1; i < VERTS.length; j = i++) {
    const [xi, yi] = VERTS[i]!
    const [xj, yj] = VERTS[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function edgeDist(x: number, y: number): number {
  let best = Infinity
  for (let i = 0, j = VERTS.length - 1; i < VERTS.length; j = i++) {
    const [ax, ay] = VERTS[j]!
    const [bx, by] = VERTS[i]!
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

// 1 inside the comet, else 0: the star polygon plus half the stroke that
// rounds its tips, and the trail. Below 32px the third dot is sub-pixel.
function markAlpha(gx: number, gy: number, px: number): number {
  if (inPoly(gx, gy) || edgeDist(gx, gy) <= STAR.sw / 2) return 1
  const dots = px < 32 ? 2 : 3
  for (let i = 0; i < dots; i++) {
    const [x, y, r] = TRAIL[i]!
    if ((gx - x) ** 2 + (gy - y) ** 2 <= r * r) return 1
  }
  return 0
}

function paintGlyph(scale: number): Buffer {
  const darwin = process.platform === 'darwin'
  const shade = darwin ? 0 : 255 // template black vs tray white
  const size = 16 * scale
  const SS = 4
  const buffer = Buffer.alloc(size * size * 4)
  // The mark fills the tray square, a hair inside it so nothing is clipped.
  const unit = (size * 0.94) / MARK_BOX.size
  const offX = size / 2 - MARK_BOX.cx * unit
  const offY = size / 2 - MARK_BOX.cy * unit
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
  setUpdateReady(version: string | undefined): void
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
