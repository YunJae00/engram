import { Globe, Plus, X } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { browserTabs, useBrowserTabs } from '../lib/browserTabs.js'
import { SiteIcon } from './SiteIcon.js'

function hostOf(url: string | undefined): string {
  if (!url || url === 'about:blank') return ''
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try { const u = new URL(url); return u.protocol === 'https:' ? u.origin : null } catch { return null }
}

export function BrowserTabs() {
  const { tabs, activeId } = useBrowserTabs()
  const mirror = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const activeLane = browserTabs.activeLane()
  // The mirror follows the active lane; keep that tab's label in step with it.
  useEffect(() => {
    if (mirror.lane === activeLane) browserTabs.setTitle(activeLane, hostOf(mirror.url))
  }, [mirror.lane, mirror.url, activeLane])
  return (
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {tabs.map((tab) => {
        const origin = tab.id === activeId ? originOf(mirror.lane === activeLane ? mirror.url : undefined) : null
        return (
          <div key={tab.id} className="browser-tab" role="tab" aria-selected={tab.id === activeId} data-active={tab.id === activeId}>
            <button className="browser-tab-face" onClick={() => browserTabs.select(tab.id)} title={tab.title || 'New tab'}>
              <span className="browser-tab-icon">{origin ? <SiteIcon origin={origin} /> : <Globe size={13} aria-hidden />}</span>
              <span className="browser-tab-label">{tab.title || 'New tab'}</span>
            </button>
            {tabs.length > 1 && (
              <button className="browser-tab-close" aria-label="Close tab" title="Close tab" onClick={() => browserTabs.close(tab.id)}><X size={12} aria-hidden /></button>
            )}
          </div>
        )
      })}
      <button className="browser-tab-add" aria-label="New tab" title="New tab" disabled={tabs.length >= 8} onClick={() => browserTabs.add()}><Plus size={15} aria-hidden /></button>
    </div>
  )
}
