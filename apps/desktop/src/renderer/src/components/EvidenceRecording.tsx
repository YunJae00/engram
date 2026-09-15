import { useEffect, useState } from 'react'
import { api } from '../api.js'

export function EvidenceRecording() {
  const [recordings, setRecordings] = useState<Awaited<ReturnType<typeof api.evidenceStatus>>>([])
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const refresh = () => void api.evidenceStatus().then(value => { if (!disposed) setRecordings(value) }).catch(() => {})
    const off = api.onEvent(event => { if (event.type === 'evidence:recording') refresh() })
    refresh()
    return () => { disposed = true; off() }
  }, [])
  useEffect(() => {
    if (!recordings.length) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recordings.length])
  const stop = async (lane: string) => {
    setBusy(value => [...value, lane]); setError('')
    try { await api.evidenceStop(lane) }
    catch { setError('Recording could not be saved. Check the conversation before sharing evidence.') }
    finally { setBusy(value => value.filter(item => item !== lane)) }
  }
  if (!recordings.length && !error) return null
  return <aside aria-label="Browser recording" className="evidence-recording">
    {recordings.map(value => <div key={value.lane}>
      <span role="status">● Recording browser tab · {Math.max(0, Math.floor((now - value.started) / 1000))}s</span>
      <button type="button" disabled={busy.includes(value.lane)} onClick={() => void stop(value.lane)}>{busy.includes(value.lane) ? 'Saving…' : 'Stop recording'}</button>
    </div>)}
    {error && <p role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p>}
  </aside>
}
