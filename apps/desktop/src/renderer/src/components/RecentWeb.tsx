import { LoaderCircle, Plus, Settings2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { recentSite } from '../lib/browser-start.js'
import { webPane } from '../lib/webPane.js'
import { useShellState } from '../state-slices.js'
import type { BotDto } from '../../../shared/types.js'
import { SiteIcon } from './SiteIcon.js'
import { WebShortcuts } from './WebShortcuts.js'
import { agentMirror } from '../lib/agentMirrorLive.js'

const KEY = 'engram.recentWeb'
function readSites(key = KEY): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(saved) ? [...new Set(saved.map(recentSite).filter((site): site is string => !!site))].slice(0, 6) : []
  } catch { return [] }
}

export function RecentWeb({ bots, onOpen }: { bots: BotDto[]; onOpen(): void }) {
  const { vaultReady, setActivity, showToast } = useShellState()
  const [sites, setSites] = useState(() => readSites())
  const [pins, setPins] = useState(() => readSites('engram.pinnedWeb'))
  const [managing, setManaging] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const pending = useRef(false)
  useEffect(() => {
    if (!bots.length) return
    setSites(held => {
      if (held.length) return held
      const origins = [...bots].sort((a, b) => (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt)).flatMap(bot => bot.webSites?.map(site => recentSite(site.origin)) ?? []).filter((site): site is string => !!site)
      const next = [...new Set(origins)].slice(0, 6)
      if (!next.length) return held
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Session shortcuts remain available. */ }
      return next
    })
  }, [bots])
  useEffect(() => {
    const last = new Map<string, string>()
    return api.onEvent(event => {
      if (event.type !== 'agent:live' && event.type !== 'agent:frame') return
      const site = recentSite(event.url)
      const lane = event.lane ?? ''
      if (!site || last.get(lane) === site) return
      last.delete(lane); last.set(lane, site)
      if (last.size > 8) last.delete(last.keys().next().value!)
      setSites(held => {
        if (held[0] === site) return held
        const next = [site, ...held.filter(item => item !== site)].slice(0, 6)
        try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Shortcuts still work for this session. */ }
        return next
      })
    })
  }, [])
  const open = async (site?: string) => {
    if (pending.current) return
    pending.current = true; setOpening(site ?? 'new')
    try {
      const channel = 'browser'
      webPane.open(channel); webPane.expand(channel, true)
      setActivity('browser'); onOpen()
      if (site) await api.agentGo(site, channel)
      else { await api.agentReset(channel); agentMirror.clearLane(channel) }
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)) }
    finally { pending.current = false; setOpening(null) }
  }
  return <><nav className="recent-web" aria-label="Website shortcuts">
    {[...pins, ...sites.filter(site => !pins.includes(site))].slice(0, 6).map(site => <button key={site} data-pinned={pins.includes(site)} disabled={!vaultReady || opening !== null} title={`${new URL(site).hostname}${pins.includes(site) ? ' · Pinned' : ''}`} aria-label={`Open ${new URL(site).hostname}`} onClick={() => void open(site)}>{opening === site ? <LoaderCircle className="computer-spinner" size={16} aria-hidden /> : <SiteIcon origin={site} shortcut />}</button>)}
    <button data-testid="web-new" disabled={!vaultReady || opening !== null} title="New browser tab" aria-label="New browser tab" onClick={() => void open()}>{opening === 'new' ? <LoaderCircle className="computer-spinner" size={16} aria-hidden /> : <Plus size={16} aria-hidden />}</button>
    <button title="Customize website shortcuts" aria-label="Customize website shortcuts" onClick={() => setManaging(true)}><Settings2 size={15} aria-hidden /></button>
  </nav>{managing && <WebShortcuts sites={sites} pins={pins} onSave={next => { setPins(next); try { localStorage.setItem('engram.pinnedWeb', JSON.stringify(next)) } catch { showToast('Could not save shortcuts. They will last for this session only.') } }} onClose={() => setManaging(false)} />}</>
}
