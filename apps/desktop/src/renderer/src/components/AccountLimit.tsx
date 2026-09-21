import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountProvider } from '../../../shared/account-profiles.js'
import { useAccountUsage } from '../lib/accountUsage.js'
import { ProviderIcon } from './ProviderIcon.js'

export function AccountLimit({ provider, profile, name, onClick }: { provider: AccountProvider; profile: string; name: string; onClick(): void }) {
  const account = useAccountUsage().find(row => row.provider === provider && row.profile === profile)
  const anchor = useRef<HTMLButtonElement>(null), id = useId()
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const windows = account?.usage?.windows ?? [], known = windows.filter(window => window.used !== undefined)
  const remaining = known.length ? Math.min(...known.map(window => 100 - window.used!)) : undefined
  const vendor = provider === 'claude' ? 'Claude' : 'ChatGPT'
  const show = () => { const rect = anchor.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(12, Math.min(rect.right - 280, innerWidth - 292)), top: rect.top > 260 ? rect.top - 8 : rect.bottom + 8, above: rect.top > 260 }) }
  return <><button ref={anchor} type="button" className="model-picker-btn account-picker" aria-label={`Manage ${vendor} accounts`} aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)} onKeyDown={event => { if (event.key === 'Escape') setPosition(null) }} onClick={() => { setPosition(null); onClick() }}>
    <svg className="account-limit-ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden data-unknown={remaining === undefined}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${remaining ?? 0} 100`} />{remaining === undefined && <path d="M7 10h6" />}</svg><span>{name}</span>
  </button>{position && createPortal(<div id={id} role="tooltip" className="account-limit-tooltip" style={{ left: position.left, top: position.top, transform: position.above ? 'translateY(-100%)' : undefined }}>
    <strong><ProviderIcon provider={provider} size={16} />{vendor} · {name}</strong>
    {windows.length ? windows.slice(0, 4).map((window, index) => <div key={index}><span>{window.name}</span><b>{window.used === undefined ? 'Unavailable' : `${Math.round(100 - window.used)}% left`}</b>{window.resetsAt !== undefined && <small>Resets {new Date(window.resetsAt).toLocaleString('en-US')}</small>}</div>) : <p>{account?.loading ? 'Checking limits…' : 'Limits unavailable'}</p>}
    <small>{account?.usage?.updatedAt ? `Checked ${new Date(account.usage.updatedAt).toLocaleTimeString('en-US')} · ` : ''}Click to manage accounts</small>
  </div>, document.body)}</>
}
