import { useEffect, useRef } from 'react'
import { agentMirror } from '../lib/agentMirrorLive.js'

// The mirrored page, painted straight onto a canvas as each frame lands.
// Nothing here goes through React: a page being scrolled sends frames several
// times a second, and rendering the thread around them that often is what
// made a smooth page look like a slideshow. One decode is in flight at a
// time - a frame that arrives while the last is still being read replaces it,
// so the picture stays current and the queue never grows.

export type FrameSource = (paint: (data: string) => void) => () => void

export function FrameScreen({ className, lane, source }: { className?: string; lane?: string; source?: FrameSource }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const context = surface.getContext('2d', { alpha: false })
    if (!context) return
    let alive = true
    let busy = false
    let waiting: string | null = null
    const paint = (source: ImageBitmap | HTMLImageElement, width: number, height: number): void => {
      if (surface.width !== width || surface.height !== height) {
        surface.width = width
        surface.height = height
      }
      context.drawImage(source, 0, 0, width, height)
      // An opaque canvas is black until something lands on it; it stays
      // out of sight until this first drawImage, or opening the pane is a
      // black rectangle for as long as the first frame takes.
      surface.dataset['painted'] = ''
    }
    const read = (data: string): void => {
      if (busy) {
        waiting = data
        return
      }
      busy = true
      const done = (): void => {
        busy = false
        const next = waiting
        waiting = null
        if (next && alive) read(next)
      }
      if (typeof createImageBitmap === 'function') {
        // The bytes are turned into a picture here and decoded off this
        // thread, so a large frame never stalls the window. Fetching the
        // frame as an address would not do: the window is served under a
        // policy that allows it no requests of its own.
        const raw = atob(data)
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        createImageBitmap(new Blob([bytes], { type: data.startsWith('iVBOR') ? 'image/png' : 'image/jpeg' }))
          .then((bitmap) => {
            if (alive) {
              paint(bitmap, bitmap.width, bitmap.height)
              surface.dataset['format'] = data.startsWith('iVBOR') ? 'png' : 'jpeg'
            }
            bitmap.close()
          })
          .catch(() => undefined)
          .finally(done)
        return
      }
      const url = `data:${data.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${data}`
      const image = new Image()
      image.onload = () => {
        if (alive) paint(image, image.naturalWidth, image.naturalHeight)
        done()
      }
      image.onerror = done
      image.src = url
    }
    // Looking at another comet: its last picture goes up at once, and the
    // fresh still replaces it when it lands.
    const kept = !source && lane ? agentMirror.heldFor(lane) : null
    if (kept) read(kept.data)
    const off = source ? source(read) : agentMirror.onFrame((data) => {
      if (!lane || agentMirror.heldFor(lane)?.data === data) read(data)
    })
    return () => {
      alive = false
      off()
    }
  }, [lane, source])
  return <canvas ref={canvas} className={className} />
}
