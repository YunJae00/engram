import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Minus } from 'lucide-react'
import { DialogHeader } from './DialogHeader.js'
import { OrbitSurface } from './OrbitSurface.js'

export function MissionBrowserDialog({ lane, name, busy, onClose, openChat }: { lane: string; name: string; busy: boolean; onClose(): void; openChat(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    const address = ref.current?.querySelector<HTMLInputElement>('[data-testid="live-address"]')
    if (address && !address.value) address.focus()
  }, [])
  return createPortal(<dialog ref={ref} className="mission-browser-dialog" aria-label={`${name} browser`} data-testid="mission-browser-dialog" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <DialogHeader closeLabel="Close browser" onClose={onClose} actions={<button className="dialog-close" aria-label="Minimize browser" title="Minimize browser" onClick={onClose}><Minus size={16} aria-hidden /></button>}>{name}</DialogHeader>
    <OrbitSurface lane={lane} name={name} busy={busy} open={openChat} />
  </dialog>, document.body)
}
