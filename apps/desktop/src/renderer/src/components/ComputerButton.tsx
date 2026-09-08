import { Monitor } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { selectDesktopSurface, useDesktopSession, useDesktopSurface } from '../lib/desktopSession.js'
import { webPane } from '../lib/webPane.js'

export function ComputerButton({ lane }: { lane: string }) {
  const { available, control } = useDesktopSession()
  const surface = useDesktopSurface(lane)
  const { folded } = useSyncExternalStore(webPane.subscribe, webPane.getSnapshot)
  const showing = surface === 'computer' && !folded
  if (available === false) return null
  return <button className={`composer-web composer-computer${showing ? ' showing' : ''}`} data-testid="composer-computer" aria-label={showing ? 'Hide computer panel' : 'Show computer panel'} title={showing ? 'Hide computer panel' : 'Show computer panel'} aria-pressed={showing} onClick={() => {
    if (showing) webPane.fold()
    else { selectDesktopSurface(lane, 'computer'); webPane.open() }
  }}><Monitor size={15} strokeWidth={1.8} aria-hidden />{control?.lane === lane && control.state === 'running' && <span className="composer-web-dot" aria-hidden />}</button>
}
