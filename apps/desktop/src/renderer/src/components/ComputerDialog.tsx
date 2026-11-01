import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { ComputerSurface } from './ComputerSurface.js'
import { DialogHeader } from './DialogHeader.js'

export function ComputerDialog({ lane, lang, onClose }: { lane: string; lang: ThreadLang; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const words = threadWords(lang)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(<dialog ref={dialog} className="mission-browser-dialog" data-testid="computer-dialog" aria-label={words.computerControls}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <DialogHeader closeLabel={words.closeComputer} onClose={onClose}>{words.computerControls}</DialogHeader>
    <ComputerSurface lane={lane} lang={lang} />
  </dialog>, document.body)
}
