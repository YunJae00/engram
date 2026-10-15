import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelChoiceDto } from '../../../shared/types.js'

export function OnboardingModel({ rows, value, loading, error, disabled, refresh, onChange }: {
  rows: ModelChoiceDto[]; value: string | null; loading: boolean; error: boolean; disabled: boolean
  refresh(): void; onChange(value: string): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const choices = [{ value: '', label: 'Provider default' }, ...rows]
  const unavailable = disabled || loading || error || !rows.length
  useLayoutEffect(() => {
    if (!open || unavailable) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect || !menu.current) return
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12
      const down = below >= Math.min(240, above)
      Object.assign(menu.current.style, { left: `${rect.left}px`, width: `${rect.width}px`, maxHeight: `${Math.min(280, down ? below : above)}px`, top: down ? `${rect.bottom + 6}px` : 'auto', bottom: down ? 'auto' : `${innerHeight - rect.top + 6}px` })
    }
    place()
    const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('button')
    selected?.focus()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, unavailable])
  useEffect(() => { if (unavailable) setOpen(false) }, [unavailable])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])
  return <div className="onboard-model">
    <span id={`${id}-label`}>Model</span>
    <button ref={trigger} type="button" className="onboard-model-trigger" data-testid="onboard-model" aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={unavailable}
      onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      <span id={`${id}-value`}>{loading ? 'Loading models…' : error ? 'Models unavailable' : value === null ? 'Choose a model' : choices.find(row => row.value === value)?.label ?? 'Choose a model'}</span>
      {loading ? <LoaderCircle size={16} className="computer-spinner" aria-hidden /> : <ChevronDown size={16} aria-hidden />}
    </button>
    {error && <button type="button" className="secondary" onClick={refresh}>Retry model list</button>}
    {open && !unavailable && createPortal(<div ref={menu} id={id} className="model-picker-menu onboard-model-menu" role="menu" aria-label="Choose a model" onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); trigger.current?.focus() }
        setOpen(false)
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }}>{choices.map(row => <button key={row.value} type="button" className="model-picker-item" role="menuitemradio" aria-checked={value === row.value} onClick={() => { onChange(row.value); setOpen(false); trigger.current?.focus() }}>
      <span className="model-picker-name">{row.label}</span>{value === row.value && <Check size={15} aria-hidden />}
    </button>)}</div>, document.body)}
  </div>
}
