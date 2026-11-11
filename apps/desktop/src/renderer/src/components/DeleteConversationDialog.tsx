import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n.js'

export function DeleteConversationDialog({ name, count, kind, summaryId, onClose, onDelete }: {
  name: string; count?: number; kind: 'chat' | 'routine'; summaryId?: string; onClose(): void; onDelete(contents: boolean): Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const [summary, setSummary] = useState<{ routines: number; facts: number; archivedChats: number } | null>(null)
  useEffect(() => {
    if (!summaryId) return
    let live = true
    setSummary(null); setError('')
    window.engram.botDeleteSummary(summaryId).then(next => { if (live) setSummary(next) }, failure => { if (live) setError(String((failure as Error).message ?? failure)) })
    return () => { live = false }
  }, [summaryId])
  // A bot delete stays disabled until its counts are known.
  const blocked = summaryId !== undefined && !summary
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  const chat = kind === 'chat'
  const items = chat ? count === 1 ? t('sidebar.conversationsOne', { n: 1 }) : t('sidebar.conversationsMany', { n: count ?? 0 }) : count === 1 ? t('sidebar.routinesOne', { n: 1 }) : t('sidebar.routinesMany', { n: count ?? 0 })
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => close.current(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timer)
  }, [closing])
  const remove = async (contents: boolean) => {
    if (busy || closing || blocked) return
    setBusy(true)
    try { await onDelete(contents); setClosing(true) }
    catch { setError(t('sidebar.deleteFailed')); setBusy(false) }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog" data-closing={closing} data-folder={count !== undefined && count > 0} aria-labelledby="delete-conversation-title" onCancel={event => { event.preventDefault(); if (!busy) setClosing(true) }}>
    <h2 id="delete-conversation-title">{count === undefined ? chat ? t('sidebar.deleteTitleConversation') : t('sidebar.deleteTitleRoutine') : chat ? t('sidebar.deleteTitleSection') : t('sidebar.deleteTitleFolder')}</h2>
    <p className="delete-conversation-name">{name}</p>
    <p>{count === undefined ? chat ? t('sidebar.removesConversation') : t('sidebar.removesRoutine') : chat ? t('sidebar.inSection', { items }) : t('sidebar.inFolder', { items })}</p>
    {summaryId && (summary ? <>
      <ul className="delete-summary">
        <li data-testid="delete-summary-routines" data-count={summary.routines}>{summary.routines === 1 ? t('sidebar.routinesOne', { n: 1 }) : t('sidebar.routinesMany', { n: summary.routines })}</li>
        <li data-testid="delete-summary-facts" data-count={summary.facts}>{summary.facts === 1 ? t('sidebar.factsOne', { n: 1 }) : t('sidebar.factsMany', { n: summary.facts })}</li>
        <li data-testid="delete-summary-archived" data-count={summary.archivedChats}>{summary.archivedChats === 1 ? t('sidebar.archivedOne', { n: 1 }) : t('sidebar.archivedMany', { n: summary.archivedChats })}</li>
      </ul>
      <p>{t('sidebar.deleteSummaryNote')}</p>
    </> : !error && <p>{t('sidebar.counting')}</p>)}
    {error && <p role="alert">{error}</p>}
    <div className="delete-conversation-actions">
      <button className="secondary" autoFocus disabled={busy || closing} onClick={() => setClosing(true)}>{t('sidebar.cancel')}</button>
      {count !== undefined && <button className="secondary" disabled={busy} onClick={() => void remove(false)}>{chat ? t('sidebar.deleteSectionOnly') : t('sidebar.deleteFolderOnly')}</button>}
      {(count === undefined || count > 0) && <button className="danger" disabled={busy || blocked} onClick={() => void remove(true)}>{count === undefined ? chat ? t('sidebar.deleteConversation') : t('sidebar.deleteRoutine') : chat ? t('sidebar.deleteSectionAnd', { items }) : t('sidebar.deleteFolderAnd', { items })}</button>}
    </div>
  </dialog>, document.body)
}
