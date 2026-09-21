import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { DevFileReview } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'

export function DeveloperFileReview({ sessionId, path, locked, onChanged }: { sessionId: string; path: string; locked: boolean; onChanged(): void }) {
  const [review, setReview] = useState<DevFileReview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [backup, setBackup] = useState(''), [kept, setKept] = useState<number[]>([])
  useEffect(() => {
    let alive = true
    setReview(null); setError(''); setBackup(''); setKept([])
    void api.devFileReview(sessionId, path).then(value => { if (alive) setReview(value) }).catch(error => { if (alive) setError(error.message) })
    return () => { alive = false }
  }, [sessionId, path])
  const discard = async (index: number) => {
    if (!review) return
    setBusy(true); setError('')
    try { const result = await api.devUndoHunk(sessionId, path, review.fingerprint, index); setReview(result.review); setBackup(result.backup); setKept([]); onChanged() }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="dev-file-review"><h3>{path}</h3><p>{review?.scope === 'task' ? 'Compared with this task’s starting files. Pre-existing edits are preserved when discarding a hunk.' : 'Compared with the latest commit. These changes may include your own edits.'}</p>
    {error && <p role="alert">{apiErrorText(error)}</p>}
    {!review && !error && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden />Loading file changes…</p>}
    {busy && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden />Restoring change…</p>}
    {review?.readOnly && <p>Read-only preview. Ask the agent to review additions, removals or changes to file identity before restoring them.</p>}
    {review?.hunks.map(hunk => <details key={`${review.fingerprint}-${hunk.index}`} open={!kept.includes(hunk.index)}><summary>Line {hunk.line}{kept.includes(hunk.index) ? ' · Kept' : ''}</summary><pre>{hunk.text}</pre><div className="dev-actions"><button className="secondary" disabled={busy} onClick={() => setKept(current => [...current, hunk.index])}>Keep change</button>{!review.readOnly && <button className="secondary" disabled={locked || busy} onClick={() => void discard(hunk.index)}>Discard this hunk</button>}</div></details>)}
    {review?.hunks.length === 0 && <p>No remaining text changes.</p>}
    {backup && <p role="status">Original content preserved in <code>{backup}</code>.</p>}
  </section>
}
