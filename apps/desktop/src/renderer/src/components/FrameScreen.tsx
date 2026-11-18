import { useEffect, useRef } from 'react'
import { agentMirror } from '../lib/agentMirrorLive.js'

export type FrameSource = (paint: (data: string) => void) => () => void

export function FrameScreen({ className, lane, source, onSize, onPaint, title, keep }: { className?: string; keep?: boolean; lane?: string; source?: FrameSource; onSize?(width: number, height: number): void; onPaint?(image: string): void; title?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const surface = canvas.current
    if (!surface) return
    const context = surface.getContext('2d', { alpha: false })
    if (!context) return
    if (!keep) {
      delete surface.dataset['painted']
      delete surface.dataset['format']
      context.clearRect(0, 0, surface.width, surface.height)
    }
    let alive = true
    let busy = false
    let waiting: string | null = null
    const paint = (source: HTMLImageElement, width: number, height: number): void => {
      if (surface.width !== width || surface.height !== height) {
        surface.width = width
        surface.height = height
        onSize?.(width, height)
      }
      context.drawImage(source, 0, 0, width, height)
      surface.dataset['painted'] = ''
      onPaint?.(source.src)
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
      const url = `data:${data.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${data}`
      const image = new Image()
      image.decoding = 'async'
      image.src = url
      void image.decode().then(() => {
        if (alive) {
          paint(image, image.naturalWidth, image.naturalHeight)
          surface.dataset['format'] = data.startsWith('iVBOR') ? 'png' : 'jpeg'
        }
      }).catch(() => undefined).finally(done)
    }
    const kept = !source && lane ? agentMirror.heldFor(lane) : null
    if (kept) read(kept.data)
    const off = source ? source(read) : agentMirror.onFrame((data) => {
      if (!lane || agentMirror.heldFor(lane)?.data === data) read(data)
    })
    return () => {
      alive = false
      off()
    }
  }, [lane, source, onSize, onPaint, keep])
  return <canvas ref={canvas} className={className} role={title ? 'img' : undefined} aria-label={title} />
}
