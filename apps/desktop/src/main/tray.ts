import { Menu, Tray, nativeImage } from 'electron'

const BODY = { cx: 12, cy: 14, rx: 10, ry: 8 }
const BUMP = { cx: 12, cy: 6.5, r: 3.2 }
const MARK_BOX = { cx: 12, cy: 12.65, size: 20 }

function markAlpha(gx: number, gy: number): number {
  if (((gx - BODY.cx) / BODY.rx) ** 2 + ((gy - BODY.cy) / BODY.ry) ** 2 <= 1) return 1
  return (gx - BUMP.cx) ** 2 + (gy - BUMP.cy) ** 2 <= BUMP.r ** 2 ? 1 : 0
}

function paintGlyph(scale: number): Buffer {
  const darwin = process.platform === 'darwin'
  const shade = darwin ? 0 : 255
  const size = 16 * scale
  const SS = 4
  const buffer = Buffer.alloc(size * size * 4)
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
          acc += markAlpha((u - offX) / unit, (v - offY) / unit)
        }
      }
      const i = (y * size + x) * 4
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
        { label: 'New Comet', accelerator: 'CommandOrControl+Shift+Space', click: actions.onQuickCapture },
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
