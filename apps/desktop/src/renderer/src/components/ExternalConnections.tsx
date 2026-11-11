import { Check, Copy, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { McpClientDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { ProviderIcon } from './ProviderIcon.js'
import { t } from '../i18n.js'

const CLIENTS = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'desktop', name: 'Claude Desktop' }] as const
export function ExternalConnections() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.mcpStatus>> | null>(null)
  const [clients, setClients] = useState<McpClientDto[]>([])
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [clientMessages, setClientMessages] = useState<Record<string, string>>({})
  const working = useRef(false)
  const revision = useRef(0)
  const refresh = async () => {
    setChecking(true)
    try { setClients(await api.mcpClients()); setClientMessages({}) }
    catch { setError(t('settingsUi.clientCheckFailed')) }
    finally { setChecking(false) }
  }
  useEffect(() => {
    let alive = true
    void api.mcpClients().then(value => { if (alive) setClients(value) }).catch(() => { if (alive) setError(t('settingsUi.clientCheckFailed')) }).finally(() => { if (alive) setChecking(false) })
    const read = () => {
      if (working.current) return
      const at = revision.current
      void api.mcpStatus().then(value => { if (alive && !working.current && at === revision.current) setStatus(value) }).catch(() => { if (alive && at === revision.current) setError(t('settingsUi.statusReadFailed')) })
    }
    read(); const timer = setInterval(read, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const act = async (key: string, work: () => Promise<void>) => {
    if (working.current) return
    working.current = true; revision.current++
    setBusy(key); setMessage(''); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : t('settingsUi.connectionFailed')) }
    finally { working.current = false; setBusy('') }
  }
  return <section className="external-connections" aria-label={t('settingsUi.externalConnections')}>
    <h3>{t('settingsUi.otherApps')}</h3>
    <p className="setting-hint">{t('settingsUi.otherAppsHint')}</p>
    <div className="external-access"><div><strong>{t('settingsUi.shareTools')}</strong><small>{t('settingsUi.shareToolsHint')}</small></div><input aria-label={t('settingsUi.shareToolsLabel')} type="checkbox" role="switch" checked={status?.enabled ?? false} disabled={!!busy || !status} onChange={event => { const enabled = event.target.checked; setStatus(value => value ? { ...value, enabled } : value); void act('toggle', async () => { try { setStatus(await api.mcpEnable(enabled)) } catch (cause) { setStatus(await api.mcpStatus()); throw cause } }) }} /></div>
    <div className="external-session" role="status">{(!status || busy === 'toggle') && <LoaderCircle size={15} className="computer-spinner" aria-hidden />}{!status ? t('settingsUi.checking') : !status.enabled ? t('settingsUi.off') : status.active ? t('settingsUi.working') : status.connected ? t(status.connected === 1 ? 'settingsUi.liveOne' : 'settingsUi.liveMany', { count: status.connected }) : t('settingsUi.readyToConnect')}</div>
    <p className="external-privacy"><ShieldCheck size={17} aria-hidden /><span>{t('settingsUi.privacy')}</span></p>
    <details className="settings-disclosure" open={status?.enabled ?? false}><summary>{t('settingsUi.appsConfig')}</summary>
    <div className="external-client-list">{CLIENTS.map(({ id, name }) => {
      const state = clients.find(client => client.id === id)?.state
      const configured = state === 'configured'
      return <div className="external-client" key={id} data-testid={`external-client-${id}`}>
        <ProviderIcon provider={id === 'codex' ? 'codex' : 'claude'} size={22} />
        <div className="external-client-copy"><strong>{name}</strong><small role={clientMessages[id] && !configured ? 'alert' : undefined}>{checking && <LoaderCircle size={13} className="computer-spinner" aria-hidden />}{clientMessages[id] || (configured ? t('settingsUi.reloadMcp') : checking ? t('settingsUi.checking') : state === 'unavailable' ? t('connection.runtimeUnavailable') : state === 'error' ? t('settingsUi.verifyFailed') : t('connection.notConnected'))}</small></div>
        <button className="secondary" disabled={!!busy || checking || !status?.enabled || configured || state === 'unavailable'} onClick={() => void act(id, async () => {
          const result = await (id === 'desktop' ? api.mcpConnectDesktop() : id === 'claude' ? api.mcpConnectCode() : api.mcpConnectCodex())
          if (!result.ok) { setClientMessages(value => ({ ...value, [id]: result.detail ?? t('settingsUi.configureFailed') })); return }
          setClients(value => [...value.filter(client => client.id !== id), { id, state: 'configured' }])
          setClientMessages(value => ({ ...value, [id]: t('settingsUi.reloadMcp') }))
        })}>{busy === id ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />{t('settingsUi.connecting')}</> : configured ? <><Check size={14} aria-hidden />{t('settingsUi.configured')}</> : t('model.connect')}</button>
      </div>
    })}</div>
    <div className="external-actions"><button className="secondary" disabled={!!busy || checking} onClick={() => void act('refresh', refresh)}><RefreshCw size={14} className={checking ? 'computer-spinner' : ''} aria-hidden />{t('settingsUi.checkStatus')}</button><button className="secondary" disabled={!!busy} onClick={() => void act('copy', async () => { await api.copyText((await api.mcpInfo()).configJson); setMessage(t('settingsUi.mcpCopied')) })}><Copy size={14} aria-hidden />{t('settingsUi.copyConfig')}</button>{!!status?.connected && <button className="secondary" disabled={!!busy} onClick={() => void act('stop', async () => { await api.mcpStop(); setStatus(await api.mcpStatus()); setMessage(t('settingsUi.sessionsStopped')) })}>{t('settingsUi.stopSessions')}</button>}</div>
    </details>
    {message && <p className="external-feedback" role="status">{message}</p>}
    {error && <p className="external-feedback" role="alert">{error}</p>}
  </section>
}
