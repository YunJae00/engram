import { Globe } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { webPane } from '../lib/webPane.js'
import { t } from '../i18n.js'

// The page panel's one handle, beside the composer where the eye already
// is: press it and the panel arrives on the right - with the open page, or
// blank with its address field when nothing is open yet. A dot says a page
// is live; it pulses while the comet's hands are on it.
export function WebPaneButton({ busy }: { busy: boolean }) {
  const { on, frame } = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const { folded, wanted } = useSyncExternalStore(webPane.subscribe, webPane.getSnapshot)
  const showing = !folded && (on || frame || wanted)
  return (
    <button
      className={`composer-web${showing ? ' showing' : ''}${busy ? ' working' : ''}`}
      data-testid="composer-web"
      aria-label={t(showing ? 'web.hide' : 'web.show')}
      title={t(showing ? 'web.hide' : 'web.show')}
      aria-pressed={showing}
      onClick={() => (showing ? webPane.fold() : webPane.open())}
    >
      <Globe size={15} strokeWidth={1.9} aria-hidden />
      {(on || busy) && <span className="composer-web-dot" aria-hidden />}
    </button>
  )
}
