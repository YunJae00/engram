import { Check, Copy, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { McpClientDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { ProviderIcon } from './ProviderIcon.js'

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
    catch { setError('Could not check client configuration. Try again.') }
    finally { setChecking(false) }
  }
  useEffect(() => {
    let alive = true
    void api.mcpClients().then(value => { if (alive) setClients(value) }).catch(() => { if (alive) setError('Could not check client configuration. Try again.') }).finally(() => { if (alive) setChecking(false) })
    const read = () => {
      if (working.current) return
      const at = revision.current
      void api.mcpStatus().then(value => { if (alive && !working.current && at === revision.current) setStatus(value) }).catch(() => { if (alive && at === revision.current) setError('Could not read connection status.') })
    }
    read(); const timer = setInterval(read, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const act = async (key: string, work: () => Promise<void>) => {
    if (working.current) return
    working.current = true; revision.current++
    setBusy(key); setMessage(''); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection failed. Try again.') }
    finally { working.current = false; setBusy('') }
  }
  return <section className="external-connections" aria-label="External connections">
    <h3>Connect other AI apps</h3>
    <div className="external-access"><div><strong>Allow local connections</strong><small>Off again when Engram restarts</small></div><input aria-label="Allow local connections for this app session" type="checkbox" role="switch" checked={status?.enabled ?? false} disabled={!!busy || !status} onChange={event => { const enabled = event.target.checked; setStatus(value => value ? { ...value, enabled } : value); void act('toggle', async () => { try { setStatus(await api.mcpEnable(enabled)) } catch (cause) { setStatus(await api.mcpStatus()); throw cause } }) }} /></div>
    <div className="external-session" role="status">{(!status || busy === 'toggle') && <LoaderCircle size={15} className="computer-spinner" aria-hidden />}{!status ? 'Checking…' : !status.enabled ? 'Off' : status.active ? 'Working' : status.connected ? `${status.connected} live ${status.connected === 1 ? 'session' : 'sessions'}` : 'Ready to connect'}</div>
    <div className="external-client-list">{CLIENTS.map(({ id, name }) => {
      const state = clients.find(client => client.id === id)?.state
      const configured = state === 'configured'
      return <div className="external-client" key={id} data-testid={`external-client-${id}`}>
        <ProviderIcon provider={id === 'codex' ? 'codex' : 'claude'} size={22} />
        <div className="external-client-copy"><strong>{name}</strong><small role={clientMessages[id] && !configured ? 'alert' : undefined}>{checking && <LoaderCircle size={13} className="computer-spinner" aria-hidden />}{clientMessages[id] || (configured ? 'Reload the client’s MCP connection.' : checking ? 'Checking…' : state === 'unavailable' ? 'Runtime unavailable' : state === 'error' ? 'Could not verify. Retry below.' : 'Not connected')}</small></div>
        <button className="secondary" disabled={!!busy || checking || !status?.enabled || configured || state === 'unavailable'} onClick={() => void act(id, async () => {
          const result = await (id === 'desktop' ? api.mcpConnectDesktop() : id === 'claude' ? api.mcpConnectCode() : api.mcpConnectCodex())
          if (!result.ok) { setClientMessages(value => ({ ...value, [id]: result.detail ?? 'Could not configure this client. Check that it is installed.' })); return }
          setClients(value => [...value.filter(client => client.id !== id), { id, state: 'configured' }])
          setClientMessages(value => ({ ...value, [id]: 'Reload the client’s MCP connection.' }))
        })}>{busy === id ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Connecting…</> : configured ? <><Check size={14} aria-hidden />Configured</> : 'Connect'}</button>
      </div>
    })}</div>
    <p className="external-privacy"><ShieldCheck size={17} aria-hidden /><span>Each tool request needs your approval. Returned content is shared with the requesting AI client. This does not control its other tools or legacy direct-memory connections.</span></p>
    <div className="external-actions"><button className="secondary" disabled={!!busy || checking} onClick={() => void act('refresh', refresh)}><RefreshCw size={14} className={checking ? 'computer-spinner' : ''} aria-hidden />Check status</button><button className="secondary" disabled={!!busy} onClick={() => void act('copy', async () => { await api.copyText((await api.mcpInfo()).configJson); setMessage('MCP configuration copied.') })}><Copy size={14} aria-hidden />Copy configuration</button>{!!status?.connected && <button className="secondary" disabled={!!busy} onClick={() => void act('stop', async () => { await api.mcpStop(); setStatus(await api.mcpStatus()); setMessage('Sessions stopped. Check any partial changes before retrying.') })}>Stop sessions</button>}</div>
    {message && <p className="external-feedback" role="status">{message}</p>}
    {error && <p className="external-feedback" role="alert">{error}</p>}
  </section>
}
