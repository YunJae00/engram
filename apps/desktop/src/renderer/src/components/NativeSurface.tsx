import { useEffect, useRef, useState } from 'react'
import { mountNativeSurface } from '../lib/nativeSurfaces.js'
import { api } from '../api.js'

export function NativeSurface({ lane, active = true }: { lane: string; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(false), [snapshot, setSnapshot] = useState<string | null>(null)
  useEffect(() => {
    if (!active || !ref.current) return
    return mountNativeSurface(ref.current, lane, setHidden)
  }, [lane, active])
  useEffect(() => {
    let alive = true
    setSnapshot(null)
    if (hidden && active) void api.nativeSnapshot(lane).then(value => { if (alive) setSnapshot(value) }).catch(() => {})
    return () => { alive = false }
  }, [hidden, active, lane])
  return <div ref={ref} className="native-browser-surface" data-testid="native-browser-surface" aria-label="Interactive web page">{hidden && snapshot && <img className="native-browser-snapshot" src={snapshot} alt="" aria-hidden />}</div>
}
