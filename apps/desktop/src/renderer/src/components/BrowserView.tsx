import { useEffect } from 'react'
import { api } from '../api.js'
import { browserTabs, useBrowserTabs } from '../lib/browserTabs.js'
import { webPane } from '../lib/webPane.js'
import { BrowserTabs } from './BrowserTabs.js'
import { WebPane } from './WebPane.js'

// The standalone browser: a Chrome-like tab strip over one live pane. Each tab
// is a lane; only the active lane's pane is mounted (its page lives on in the
// main process, so switching back is instant), and the pane's own top bar
// carries the address field and back/forward/reload.
export function BrowserView() {
  const { tabs } = useBrowserTabs()
  const lane = browserTabs.activeLane()
  // A fresh or freshly-selected tab shows its start screen rather than nothing.
  useEffect(() => { webPane.open(lane) }, [lane])
  return (
    <div className="browser-view" data-tabs={tabs.length}>
      <BrowserTabs />
      <WebPane key={lane} channel={lane} standalone busy={false} onStop={() => void api.agentReset(lane)} />
    </div>
  )
}
