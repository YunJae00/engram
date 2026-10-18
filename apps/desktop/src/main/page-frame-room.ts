import type { Frame } from 'playwright-core'

// Whether a frame has room on the page: an ad slot or a tracker sized to
// nothing shows the person nothing, so it need not be read.
const FRAME_ROOM_MS = 1_500

export async function takesRoom(frame: Frame): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const room = (async () => {
    const element = await frame.frameElement()
    try {
      return await element.evaluate((node) => {
        const box = (node as Element).getBoundingClientRect()
        const style = getComputedStyle(node as Element)
        return box.width > 2 && box.height > 2 && style.display !== 'none' && style.visibility !== 'hidden'
      })
    } finally {
      void element.dispose().catch(() => undefined)
    }
  })()
  try {
    // Unsure is read: only a frame known to take no room is passed over.
    return await Promise.race([room.catch(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), FRAME_ROOM_MS) })])
  } catch {
    return true
  } finally {
    clearTimeout(timer)
  }
}
