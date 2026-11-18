import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useApp } from '../state.js'

export function BrowserActions({ lane, url, live }: { lane: string; url?: string; live: boolean }) {
  const { showToast } = useApp()
  const [history, setHistory] = useState({ back: false, forward: false })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let stale = false
    setHistory({ back: false, forward: false })
    if (live) void api.agentHistory(lane).then((value) => { if (!stale) setHistory(value) }).catch(() => {})
    return () => { stale = true }
  }, [lane, url, live, busy])
  const navigate = async (direction: 'back' | 'forward' | 'reload') => {
    setBusy(true)
    try { await api.agentNavigate(lane, direction) } catch { showToast(t('live.navFailed')) }
    finally { setBusy(false) }
  }
  return <div className="browser-actions">
    <button className="live-dock-act" title={t('live.back')} aria-label={t('live.back')} disabled={busy || !history.back} onClick={() => void navigate('back')}><ArrowLeft size={14} /></button>
    <button className="live-dock-act" title={t('live.forward')} aria-label={t('live.forward')} disabled={busy || !history.forward} onClick={() => void navigate('forward')}><ArrowRight size={14} /></button>
    <button className="live-dock-act" data-testid="live-refresh" title={t('live.reload')} aria-label={t('live.reload')} disabled={busy || !live} onClick={() => void navigate('reload')}><RotateCw size={14} /></button>
  </div>
}
