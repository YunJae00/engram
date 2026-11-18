import type { DesktopControlStatusDto } from '../shared/desktop.js'
import { hideControlOverlay, updateControlOverlay } from './desktop-overlay.js'

const IDLE_ANNOUNCE_MS = 1500
const FRAME_HIDE_MS = 1000

export function controlAnnouncer(read: () => DesktopControlStatusDto, starting: () => boolean, publish: (status: DesktopControlStatusDto) => void): { announce(): void; announceIdle(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const announce = (): void => {
    clearTimeout(timer)
    timer = undefined
    const status = read()
    if (status.state === 'running') updateControlOverlay(status)
    else hideControlOverlay()
    publish(status)
  }
  const announceIdle = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      // A start that fails without a stop must still end with the idle notice.
      if (starting()) announceIdle()
      else if (read().inputActive !== true) announce()
    }, IDLE_ANNOUNCE_MS)
  }
  return { announce, announceIdle }
}

export function steadyVisible(held: { hiddenSince?: number | undefined }, visible: boolean, shown: boolean, now = Date.now()): boolean {
  if (visible || !shown) { held.hiddenSince = undefined; return visible }
  held.hiddenSince ??= now
  return now - held.hiddenSince < FRAME_HIDE_MS
}
