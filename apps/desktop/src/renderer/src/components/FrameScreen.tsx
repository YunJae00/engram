import { useEffect, useRef } from 'react'
import { agentMirror } from '../lib/agentMirrorLive.js'

// The mirrored page, painted straight onto a canvas as each frame lands.
// Nothing here goes through React: a page being scrolled sends frames several
// times a second, and rendering the thread around them that often is what
// made a smooth page look like a slideshow. One decode is in flight at a
// time - a frame that arrives while the last is still being read replaces it,
// so the picture stays current and the queue never grows.

export function FrameScreen({ className }: { className?: string }) {
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
        createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
          .then((bitmap) => {
            if (alive) paint(bitmap, bitmap.width, bitmap.height)
            bitmap.close()
          })
          .catch(() => undefined)
          .finally(done)
        return
      }
      const url = `data:image/jpeg;base64,${data}`
      const image = new Image()
      image.onload = () => {
        if (alive) paint(image, image.naturalWidth, image.naturalHeight)
        done()
      }
      image.onerror = done
      image.src = url
    }
    const off = agentMirror.onFrame(read)
    return () => {
      alive = false
      off()
    }
  }, [])
  return <canvas ref={canvas} className={className} />
}
