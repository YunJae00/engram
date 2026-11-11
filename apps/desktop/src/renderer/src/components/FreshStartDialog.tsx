import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n.js'

export function FreshStartDialog({ onCancel, onConfirm, busy }: { onCancel(): void; onConfirm(): void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const host = document.querySelector('[data-testid="shell"]') ?? document.body
  return createPortal(<dialog ref={dialog} role="dialog" className="delete-conversation-dialog" data-testid="bots-fresh-confirm" aria-labelledby="bots-fresh-confirm-title"
    onCancel={event => { event.preventDefault(); onCancel() }}
    onKeyDown={event => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); onCancel() }}>
    <h2 id="bots-fresh-confirm-title">{t('bots.freshConfirmTitle')}</h2>
    <p>{t('bots.freshHint')}</p>
    <div className="delete-conversation-actions">
      <button type="button" className="secondary" data-testid="bots-fresh-confirm-cancel" autoFocus onClick={onCancel}>{t('bots.freshCancel')}</button>
      <button type="button" className="danger" data-testid="bots-fresh-confirm-ok" disabled={busy} onClick={onConfirm}>{t('bots.freshConfirmOk')}</button>
    </div>
  </dialog>, host)
}
