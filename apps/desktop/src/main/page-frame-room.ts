import type { Frame } from 'playwright-core'

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
    return await Promise.race([room.catch(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), FRAME_ROOM_MS) })])
  } catch {
    return true
  } finally {
    clearTimeout(timer)
  }
}
