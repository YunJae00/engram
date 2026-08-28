import { Menu, Tray, nativeImage } from 'electron'

const STARS = [
  { x: 5.55, y: 9.77, r: 1.84, a: 1 },
  { x: 11.47, y: 4.8, r: 1.43, a: 1 },
  { x: 3.72, y: 4.53, r: 0.98, a: 0.85 },
  { x: 12.49, y: 11.33, r: 0.9, a: 0.62 },
  { x: 8.88, y: 7.66, r: 0.71, a: 0.34 },
]
const EDGES: [{ x: number; y: number }, { x: number; y: number }][] = [
  [STARS[0]!, STARS[2]!],
  [STARS[0]!, STARS[4]!],
  [STARS[4]!, STARS[1]!],
  [STARS[1]!, STARS[3]!],
]
const EDGE_R = 0.3
const EDGE_A = 0.5

function segDist2(u: number, v: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((u - a.x) * vx + (v - a.y) * vy) / (vx * vx + vy * vy)))
  const dx = u - (a.x + vx * t)
  const dy = v - (a.y + vy * t)
  return dx * dx + dy * dy
}

function paintGlyph(scale: number): Buffer {
  const darwin = process.platform === 'darwin'
  const shade = darwin ? 0 : 255 // template black vs tray white
  const size = 16 * scale
  const SS = 4
  const buffer = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / scale
          const v = (y + (sy + 0.5) / SS) / scale
          let alpha = 0
          for (const s of STARS) {
            const dx = u - s.x
            const dy = v - s.y
            if (dx * dx + dy * dy <= s.r * s.r) {
              alpha = s.a
              break
            }
          }
          if (alpha === 0) {
            for (const [a, b] of EDGES) {
              if (segDist2(u, v, a, b) <= EDGE_R * EDGE_R) {
                alpha = EDGE_A
                break
              }
            }
          }
          acc += alpha
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
