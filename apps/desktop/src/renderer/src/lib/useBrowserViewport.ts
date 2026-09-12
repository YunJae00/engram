import { useEffect, type RefObject } from 'react'
import { api } from '../api.js'

export function useBrowserViewport(element: RefObject<HTMLElement>, lane: string, active: boolean): void {
  useEffect(() => {
    const box = element.current
    if (!box || !active) return
    let asked = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const rect = box.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) { asked = ''; return }
      const width = Math.round(rect.width / 8) * 8, height = Math.round(rect.height / 8) * 8
      const size = `${width}:${height}`
      if (size === asked) return
      asked = size
      void api.agentResize(lane, width, height).catch(() => { if (asked === size) asked = '' })
    }
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(measure, 180) })
    observer.observe(box)
    measure()
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [element, lane, active])
}
