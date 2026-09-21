import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { DevConsoleState, DevWorkspace } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'
import { usePaneSurface } from '../lib/usePaneSurface.js'

export function DeveloperConsole({ workspace, locked, onClose }: { workspace: DevWorkspace; locked: boolean; onClose(): void }) {
  const [command, setCommand] = useState(''), [state, setState] = useState<DevConsoleState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const surface = usePaneSurface(onClose)
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const value = await api.devConsole(workspace); if (alive) setState(value) }
      catch (error) { if (alive) setError(apiErrorText((error as Error).message)) }
      finally { if (alive) timer = setTimeout(() => void refresh(), 500) }
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [workspace.repoId, workspace.sessionId])
  const run = async () => {
    if (busy || state?.running || !command.trim()) return
    setBusy(true); setError('')
    try { setState(await api.devRunCommand(workspace, command)) }
    catch (error) { setError(apiErrorText((error as Error).message)) }
    finally { setBusy(false) }
  }
  return <aside ref={surface} className="dev-files dev-console" aria-label="Command console"><header><strong>Command console</strong><button className="dev-control" aria-label="Close command console" onClick={onClose}><X size={16} /></button></header>
    <p>Run non-interactive commands in this workspace. Commands use your system permissions, not the task’s AI access mode. Closing this panel does not stop a command.</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void run() }}><textarea aria-label="Workspace command" placeholder="Enter a build, test or Git command…" value={command} maxLength={20_000} onChange={event => setCommand(event.target.value)} /><button className="primary" disabled={locked || busy || state?.running || !command.trim()}>Run command…</button><button type="button" className="secondary" disabled={!state?.running} onClick={() => void api.devStopCommand(workspace).catch(error => setError(apiErrorText(error.message)))}>Stop command</button></form>
    {state && <><code className="dev-console-command" aria-label="Executed command">{state.command}</code><p role="status">{state.running ? 'Running' : state.stopped ? 'Stopped — inspect partial changes before retrying.' : `Exited (${state.exitCode ?? 'unknown'})`}{state.truncated && ' · Only the last 200,000 characters are retained.'}</p><pre tabIndex={0} aria-label="Command output">{state.output || (state.running ? 'Waiting for output…' : 'No output.')}</pre>{state.logPath && <small>Saved locally: {state.logPath}</small>}</>}
  </aside>
}
