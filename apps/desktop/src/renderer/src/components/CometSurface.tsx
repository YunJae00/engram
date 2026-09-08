import { ChevronsRight } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useDesktopSurface } from '../lib/desktopSession.js'
import { webPane } from '../lib/webPane.js'
import { useShellState } from '../state-slices.js'
import { ComputerSurface } from './ComputerSurface.js'
import { SurfaceTabs } from './SurfaceTabs.js'
import { WebPane } from './WebPane.js'

export function CometSurface({ channel, name, busy, onStop, children }: { channel: string; name: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  const { activity } = useShellState()
  const { folded } = useSyncExternalStore(webPane.subscribe, webPane.getSnapshot)
  const surface = useDesktopSurface(channel)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => { webPane.fold(); setClosing(false) }, 170)
    return () => clearTimeout(timer)
  }, [closing])
  useEffect(() => setClosing(false), [channel, surface])
  if (surface === 'browser') return <WebPane channel={channel} busy={busy} onStop={onStop} toolbar={<SurfaceTabs lane={channel} onSelect={webPane.open} />}>{children}</WebPane>
  if (activity !== 'bots' || folded) return null
  return <aside className={`web-pane desktop-chat-pane${closing ? ' closing' : ''}`} data-testid="desktop-chat-pane" aria-label={`Computer for ${name}`}>
    <div className="web-pane-inner">
      <div className="computer-pane-head"><SurfaceTabs lane={channel} onSelect={webPane.open} /><button className="computer-icon" data-testid="desktop-pane-fold" title="Hide computer panel" aria-label="Hide computer panel" onClick={() => setClosing(true)}><ChevronsRight size={14} aria-hidden /></button></div>
      <ComputerSurface key={channel} lane={channel} />
    </div>
  </aside>
}
