import { LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { cometChannel } from '../lib/cometThreads.js'
import { selectComet } from '../lib/cometThreadsLive.js'
import { selectDesktopSurface } from '../lib/desktopSession.js'
import { recentSite } from '../lib/browser-start.js'
import { webPane } from '../lib/webPane.js'
import { useShellState } from '../state-slices.js'
import type { BotDto } from '../../../shared/types.js'

const KEY = 'engram.recentWeb'
function readSites(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(saved) ? [...new Set(saved.map(recentSite).filter((site): site is string => !!site))].slice(0, 7) : []
  } catch { return [] }
}

export function RecentWeb({ bots, onOpen }: { bots: BotDto[]; onOpen(): void }) {
  const { vaultReady, setActivity, showToast } = useShellState()
  const [sites, setSites] = useState(readSites)
  const [opening, setOpening] = useState<string | null>(null)
  const pending = useRef(false)
  useEffect(() => {
    if (!bots.length) return
    setSites(held => {
      if (held.length) return held
      const origins = [...bots].sort((a, b) => (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt)).flatMap(bot => bot.webSites?.map(site => recentSite(site.origin)) ?? []).filter((site): site is string => !!site)
      const next = [...new Set(origins)].slice(0, 7)
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
        const next = [site, ...held.filter(item => item !== site)].slice(0, 7)
        try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Shortcuts still work for this session. */ }
        return next
      })
    })
  }, [])
  const open = async (site?: string) => {
    if (pending.current) return
    pending.current = true; setOpening(site ?? 'new')
    try {
      const bot = await api.botCreate({ name: site ? new URL(site).hostname : 'New browser', purpose: '' })
      const channel = cometChannel(bot.id)
      selectDesktopSurface(channel, 'browser'); webPane.open(channel); webPane.expand(channel, true)
      selectComet(bot.id); setActivity('bots'); onOpen()
      if (site) await api.agentGo(site, channel)
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)) }
    finally { pending.current = false; setOpening(null) }
  }
  return <nav className="recent-web" aria-label="Recent websites">
    {sites.map(site => <button key={site} disabled={!vaultReady || opening !== null} title={site} onClick={() => void open(site)}>{opening === site ? <LoaderCircle className="computer-spinner" size={18} aria-hidden /> : <span className="recent-web-mark" aria-hidden>{new URL(site).hostname.replace(/^www\./, '').slice(0, 1).toUpperCase()}</span>}<span>{new URL(site).hostname.replace(/^www\./, '')}</span></button>)}
    <button className="recent-web-new" data-testid="web-new" disabled={!vaultReady || opening !== null} title="New browser tab" onClick={() => void open()}>{opening === 'new' ? <LoaderCircle className="computer-spinner" size={18} aria-hidden /> : <Plus size={18} aria-hidden />}<span>New</span></button>
  </nav>
}
