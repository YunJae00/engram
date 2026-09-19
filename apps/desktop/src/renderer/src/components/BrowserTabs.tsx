import { Globe, LoaderCircle, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BrowserTabDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { useShellState } from '../state-slices.js'
import { SiteIcon } from './SiteIcon.js'

export function BrowserTabs({ channel, busy }: { channel: string; busy: boolean }) {
  const [tabs, setTabs] = useState<BrowserTabDto[]>([])
  const [pending, setPending] = useState(false)
  const changing = useRef(false)
  const { showToast } = useShellState()
  useEffect(() => {
    let current = true
    let received = false
    const off = api.onEvent(event => {
      if (event.type !== 'agent:tabs' || event.lane !== channel) return
      received = true
      setTabs(event.tabs)
      if (!event.tabs.length) agentMirror.clearLane(channel)
    })
    void api.browserTabs(channel).then(value => { if (current && !received) setTabs(value) }).catch(() => {})
    return () => { current = false; off() }
  }, [channel])
  const change = async (action: 'add' | 'select' | 'close', id?: string) => {
    if (busy || changing.current) return
    changing.current = true
    setPending(true)
    try { await api.browserTab(channel, action, id) }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not change tabs') }
    finally { changing.current = false; setPending(false) }
  }
  const shown: BrowserTabDto[] = tabs.length ? tabs : [{ id: '', url: 'about:blank', active: true }]
  return <div className="browser-tabs" role="tablist" aria-label="Browser tabs" aria-busy={pending}>
    {shown.map(tab => {
      let origin: string | undefined
      let title = 'New tab'
      try {
        const url = new URL(tab.url)
        if (url.protocol === 'https:' || url.protocol === 'http:') { origin = url.origin; title = url.hostname }
      } catch { /* Blank pages have no origin. */ }
      title = tab.title || title
      return <div key={tab.id} className="browser-tab" data-active={tab.active}>
        <button role="tab" aria-selected={tab.active} className="browser-tab-face" disabled={busy || pending || !tab.id} onClick={() => void change('select', tab.id)} title={tab.url}>
          <span className="browser-tab-icon">{origin ? <SiteIcon origin={origin} /> : <Globe size={13} aria-hidden />}</span>
          <span className="browser-tab-label">{title}</span>
        </button>
        {tab.id && <button className="browser-tab-close" aria-label={`Close ${title}`} disabled={busy || pending} onClick={() => void change('close', tab.id)}><X size={12} aria-hidden /></button>}
      </div>
    })}
    <button className="browser-tab-add" aria-label="New tab" title={busy ? 'Stop the current task to change tabs' : 'New tab'} disabled={busy || pending || tabs.length >= 8} onClick={() => void change('add')}>
      {pending ? <LoaderCircle size={15} className="computer-spinner" aria-hidden /> : <Plus size={15} aria-hidden />}
    </button>
  </div>
}
