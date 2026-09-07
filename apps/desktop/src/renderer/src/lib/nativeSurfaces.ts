import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { NativeSurfaceDto } from '../../../shared/types.js'

let enabled: Promise<boolean> | undefined
export function useNativeBrowser(): boolean {
  const [value, setValue] = useState(false)
  useEffect(() => {
    let alive = true
    enabled ??= api.nativeEnabled().catch(() => false)
    void enabled.then((native) => { if (alive) setValue(native) })
    return () => { alive = false }
  }, [])
  return value
}

const surfaces = new Map<HTMLElement, string>()
let timer: ReturnType<typeof setInterval> | undefined
let last = ''
let sent = 0

function measure(): void {
  const result: NativeSurfaceDto[] = []
  const overlays = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"], .brief-overlay, .sheet-overlay, .workspace-menu, .help-panel, .mission-add-menu, .tour-overlay')]
  if (document.visibilityState === 'visible') for (const [element, lane] of surfaces) {
    const rect = element.getBoundingClientRect()
    if (rect.width < 16 || rect.height < 16 || rect.x < 0 || rect.y < 0 || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) continue
    if (element.closest('[hidden], [inert]')) continue
    if (overlays.some((overlay) => {
      if (overlay.contains(element)) return false
      const box = overlay.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
    })) continue
    // Native child windows cannot sit below an HTML menu or modal.
    const clear = [0.02, 0.5, 0.98].every((fx) => [0.02, 0.5, 0.98].every((fy) => {
      const top = document.elementFromPoint(rect.x + rect.width * fx, rect.y + rect.height * fy)
      return top === element || (top !== null && element.contains(top))
    }))
    if (clear) result.push({ lane, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }
  const next = JSON.stringify(result)
  if (next === last && Date.now() - sent < 1000) return
  last = next
  sent = Date.now()
  void api.nativeLayout(result).catch(() => { last = '' })
}

export function mountNativeSurface(element: HTMLElement, lane: string): () => void {
  surfaces.set(element, lane)
  if (!timer) timer = setInterval(measure, 33)
  measure()
  return () => {
    surfaces.delete(element)
    measure()
    if (!surfaces.size) { clearInterval(timer); timer = undefined }
  }
}
