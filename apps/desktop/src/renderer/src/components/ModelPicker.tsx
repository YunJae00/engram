import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ModelChoiceDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

// Which model answers, changed where the asking happens. The brain itself is
// chosen in Settings and stays chosen; this is which of its models, next to
// the composer the way every chat app puts it - a person who wants the big
// model for one hard question should not have to go and find a settings
// screen.
//
// Model names and ids come from each runtime's catalog.

// Until the plan's list arrives (a cold start of the runtime), the only
// honest choice is the runtime's own default.
const AUTO = ''

export function useModelChoices(engine: 'claude' | 'codex' | null) {
  const [result, setResult] = useState<{ engine: typeof engine; rows: ModelChoiceDto[]; loading: boolean; error: boolean }>({ engine, rows: [], loading: true, error: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let serial = 0
    if (!engine) return
    const read = () => {
      const at = ++serial
      setResult((prior) => ({ engine, rows: prior.engine === engine ? prior.rows : [], loading: true, error: false }))
      void api.modelsList(engine).then((rows) => {
        if (alive && at === serial) setResult({ engine, rows, loading: false, error: rows.length === 0 })
      }).catch(() => { if (alive && at === serial) setResult({ engine, rows: [], loading: false, error: true }) })
    }
    read()
    const off = api.onEvent((event) => {
      if (event.type === 'models:changed') read()
    })
    return () => { alive = false; off() }
  }, [engine, attempt])
  return { ...(result.engine === engine ? result : { rows: [], loading: true, error: false }), refresh: () => setAttempt((value) => value + 1) }
}

export function ModelPicker() {
  const [engine, setEngine] = useState<'claude' | 'codex' | null>(null)
  const [model, setModel] = useState(AUTO)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const { rows, loading, error, refresh } = useModelChoices(engine)
  const [saveError, setSaveError] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!box.current || !menu.current) return
      const anchor = box.current.getBoundingClientRect()
      const host = box.current.closest('.bots-chat, .cosmos-chat, .bots-main')?.getBoundingClientRect()
      const left = Math.max(0, host?.left ?? 0) + 8
      const right = Math.min(innerWidth, host?.right ?? innerWidth) - 8
      const width = Math.min(300, right - left)
      const above = Math.max(0, anchor.top - Math.max(8, host?.top ?? 8) - 6)
      const below = Math.max(0, Math.min(innerHeight - 8, host?.bottom ?? innerHeight - 8) - anchor.bottom - 6)
      const down = above < 120 && below > above
      Object.assign(menu.current.style, {
        width: `${width}px`, left: `${Math.max(left, Math.min(anchor.left, right - width)) - anchor.left}px`,
        maxHeight: `${Math.min(360, down ? below : above)}px`,
        top: down ? 'calc(100% + 6px)' : 'auto', bottom: down ? 'auto' : 'calc(100% + 6px)',
        transformOrigin: down ? 'top left' : 'bottom left',
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, rows])

  const read = () =>
    void api
      .settingsGet()
      .then((s) => {
        setEngine(s.defaultEngine)
        setModel((s.defaultEngine === 'codex' ? s.codexModel : s.claudeModel) ?? AUTO)
      })
      .catch(() => {})
  useEffect(() => {
    read()
    // Settings can change anywhere - the sheet, another window - and the
    // label has to be the truth, not the last thing this menu did.
    return api.onEvent((event) => {
      if (event.type === 'settings:changed') read()
    })
  }, [])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  if (engine === null) return null
  const label = rows.find((r) => r.value === model)?.label ?? (model || t('settings.modelAuto'))
  const choose = (next: string) => {
    setSaveError(false)
    void api
      .settingsGet()
      .then((s) => api.settingsSet({ ...s, [engine === 'codex' ? 'codexModel' : 'claudeModel']: next }))
      .then(() => { setModel(next); setOpen(false) })
      .catch(() => setSaveError(true))
  }
  const choices: ModelChoiceDto[] = [{ value: AUTO, label: t('settings.modelAuto'), detail: t('model.autoDetail') }, ...rows]
  return (
    <div className="model-picker" ref={box}>
      <button
        className="model-picker-btn"
        data-testid="model-picker"
        title={t('model.pick')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={11} strokeWidth={2.2} aria-hidden />
      </button>
      {open && (
        <div className="model-picker-menu" ref={menu} role="menu" data-testid="model-picker-menu">
          {choices.map((row) => (
            <button
              key={row.value || 'auto'}
              role="menuitem"
              className="model-picker-item"
              title={row.detail}
              data-testid={`model-pick-${row.value || 'auto'}`}
              onClick={() => choose(row.value)}
            >
              <span className="model-picker-tick">{model === row.value && <Check size={12} strokeWidth={2.4} aria-hidden />}</span>
              <span className="model-picker-name">
                {row.label}
                {row.detail && <span className="model-picker-detail">{row.detail}</span>}
              </span>
            </button>
          ))}
          {loading && <div className="model-picker-note" role="status">Loading models…</div>}
          {error && <button className="model-picker-item" role="menuitem" onClick={refresh}>Models unavailable · Retry</button>}
          {saveError && <div className="model-picker-note" role="alert">Could not save the model. Try again.</div>}
        </div>
      )}
    </div>
  )
}
