import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DesktopBindingDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { webPane } from '../lib/webPane.js'
import { useShellState } from '../state-slices.js'
import { OrbitSurface } from './OrbitSurface.js'
import { WebPane } from './WebPane.js'

export function CometSurface({ channel, name, busy, onStop, children }: { channel: string; name: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  const { activity } = useShellState()
  const { folded } = useSyncExternalStore(webPane.subscribe, webPane.getSnapshot)
  const [binding, setBinding] = useState<DesktopBindingDto | null>()
  useEffect(() => {
    let alive = true
    let version = 0
    const update = () => {
      const request = ++version
      void api.desktopBindings().then((items) => {
        if (alive && request === version) setBinding(items.find((item) => item.lane === channel) ?? null)
      }).catch(() => { if (alive && request === version) setBinding(null) })
    }
    update()
    const off = api.onEvent((event) => { if (event.type === 'desktop:changed') update() })
    return () => { alive = false; off() }
  }, [channel])
  const source = binding?.source
  useEffect(() => {
    if (source && activity === 'bots') webPane.open()
  }, [source, activity])
  if (binding === undefined) return null
  if (!binding) return <WebPane channel={channel} busy={busy} onStop={onStop}>{children}</WebPane>
  if (activity !== 'bots' || folded) return null
  return <aside className="web-pane desktop-chat-pane" data-testid="desktop-chat-pane" aria-label={`App window for ${name}`}>
    <div className="web-pane-inner">
      <OrbitSurface key={binding.source} lane={channel} name={name} initialBinding={binding} open={webPane.open} onFold={webPane.fold} />
    </div>
  </aside>
}
