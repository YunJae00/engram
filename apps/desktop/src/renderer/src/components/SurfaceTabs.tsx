import { Globe, Monitor } from 'lucide-react'
import { selectDesktopSurface, useDesktopSurface } from '../lib/desktopSession.js'

export function SurfaceTabs({ lane, onSelect }: { lane: string; onSelect?(): void }) {
  const selected = useDesktopSurface(lane)
  const choose = (surface: 'browser' | 'computer') => { onSelect?.(); selectDesktopSurface(lane, surface) }
  return <div className="computer-surface-tabs" role="group" aria-label="Work surface">
    <button aria-pressed={selected === 'browser'} onClick={() => choose('browser')}><Globe size={13} aria-hidden />Browser</button>
    <button aria-pressed={selected === 'computer'} onClick={() => choose('computer')}><Monitor size={13} aria-hidden />Computer</button>
  </div>
}
