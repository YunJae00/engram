import { useEffect, useRef } from 'react'
import { mountNativeSurface } from '../lib/nativeSurfaces.js'

export function NativeSurface({ lane, active = true }: { lane: string; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active || !ref.current) return
    return mountNativeSurface(ref.current, lane)
  }, [lane, active])
  return <div ref={ref} className="native-browser-surface" data-testid="native-browser-surface" aria-label="Interactive web page" />
}
