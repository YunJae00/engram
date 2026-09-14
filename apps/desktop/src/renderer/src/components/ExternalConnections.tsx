import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

export function ExternalConnections() {
  const [status, setStatus] = useState<{ enabled: boolean; active: boolean; connected: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const working = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    let alive = true
    const read = () => {
      if (working.current) return
      const at = revision.current
      void api.mcpStatus().then(value => { if (alive && !working.current && at === revision.current) setStatus(value) }).catch(() => { if (alive && at === revision.current) setMessage('Could not read connection status.') })
    }
    read(); const timer = setInterval(read, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const act = async (work: () => Promise<void>) => {
    if (working.current) return
    working.current = true; revision.current++
    setBusy(true); setMessage('')
    try { await work() } catch (error) { setMessage(error instanceof Error ? error.message : 'Connection failed. Try again.') }
    finally { working.current = false; setBusy(false) }
  }
  return <div className="external-connections">
    <h2>Use Engram from another AI</h2>
    <p className="setting-hint">Keep working in your preferred client. It can request Engram’s memory, browser, files and supported Office tools while this app is open. Your client chooses the model.</p>
    <div className="setting-row"><label htmlFor="external-enabled">Allow local connections for this app session</label><input id="external-enabled" type="checkbox" role="switch" checked={status?.enabled ?? false} disabled={busy || !status} onChange={event => { const enabled = event.target.checked; setStatus(value => value ? { ...value, enabled } : value); void act(async () => { try { setStatus(await api.mcpEnable(enabled)) } catch (error) { setStatus(await api.mcpStatus()); throw error } }) }} /></div>
    <p className="setting-hint">Each request asks before accessing data or taking action. Returned content is shared with the requesting AI client. Disabling this connection stops its active requests; it does not control the client’s other tools or older direct-memory configurations.</p>
    <div className="external-client-list">{([
      ['Claude Code', () => api.mcpConnectCode()],
      ['Codex', () => api.mcpConnectCodex()],
      ['Claude Desktop', () => api.mcpConnectDesktop()],
    ] as const).map(([name, connect]) => <div className="setting-row" key={name}><span>{name}</span><button className="secondary" disabled={busy || !status?.enabled} onClick={() => void act(async () => { const result = await connect(); setMessage(result.ok ? `${name} configured. Reload its MCP connection to begin.` : result.detail ?? `${name} is not available on this machine.`) })}>Connect</button></div>)}</div>
    <div className="mcp-actions"><button className="secondary" disabled={busy} onClick={() => void act(async () => { await api.copyText((await api.mcpInfo()).configJson); setMessage('MCP configuration copied. Add it to a compatible local client.') })}>Copy MCP configuration</button><button className="secondary" disabled={busy || !status?.connected} onClick={() => void act(async () => { await api.mcpStop(); setStatus(await api.mcpStatus()); setMessage('External sessions stopped. Inspect any operation already in progress before retrying.') })}>Stop sessions</button></div>
    <p className="setting-hint" role="status">{message || (status?.enabled ? `${status.connected} connected · ${status.active ? 'Request in progress' : 'Ready'}` : 'Off. No external operations are accepted.')}</p>
  </div>
}
