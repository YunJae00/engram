import { ArrowDown, ArrowUp, Pin, Trash2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { recentSite } from '../lib/browser-start.js'
import { SiteIcon } from './SiteIcon.js'

export function WebShortcuts({ sites, pins, onSave, onClose }: { sites: string[]; pins: string[]; onSave(pins: string[]): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(pins)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const toggle = (site: string) => {
    if (draft.includes(site)) setDraft(draft.filter(value => value !== site))
    else if (draft.length < 6) setDraft([...draft, site])
    else setError('Up to six websites can be pinned. Unpin one first.')
  }
  const move = (index: number, step: number) => {
    const next = [...draft]
    ;[next[index], next[index + step]] = [next[index + step]!, next[index]!]
    setDraft(next)
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog web-shortcuts-dialog" aria-labelledby="web-shortcuts-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="web-shortcuts-title">Website shortcuts</h2>
    <p>Pinned websites stay in place. Recent websites fill the remaining spaces. Shortcuts open the browser, without creating a conversation.</p>
    <form className="web-shortcut-add" onSubmit={event => {
      event.preventDefault(); setError('')
      const site = recentSite(/^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`)
      if (!site || !address.trim()) { setError('Enter an HTTP or HTTPS website address without sign-in details.'); return }
      if (!draft.includes(site)) toggle(site)
      setAddress('')
    }}><input aria-label="Website to pin" placeholder="example.com" value={address} onChange={event => setAddress(event.target.value)} /><button className="secondary" type="submit">Pin website</button></form>
    <div className="web-shortcut-list">{[...draft, ...sites.filter(site => !draft.includes(site))].map(site => {
      const index = draft.indexOf(site)
      return <div className="web-shortcut-row" key={site}><SiteIcon origin={site} /><span title={site}>{new URL(site).hostname}</span>
        {index >= 0 && <><button disabled={index === 0} aria-label={`Move ${site} up`} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button disabled={index === draft.length - 1} aria-label={`Move ${site} down`} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></>}
        <button aria-label={`${index >= 0 ? 'Unpin' : 'Pin'} ${site}`} aria-pressed={index >= 0} onClick={() => { setError(''); toggle(site) }}>{index >= 0 ? <Trash2 size={14} /> : <Pin size={14} />}</button>
      </div>
    })}</div>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => { onSave(draft); onClose() }}>Save shortcuts</button></div>
  </dialog>, document.body)
}
