import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ModelChoiceDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

// Which model answers, changed where the asking happens. The brain itself is
// chosen in Settings and stays chosen; this is which of its models, next to
// the composer the way every chat app puts it - a person who wants the big
// model for one hard question should not have to go and find a settings
// screen.
//
// The list is the plan's own, as the Claude runtime reports it: the names
// its menu shows, the ids it takes. Nothing here knows a model by name.
// ChatGPT's runtime does not report a list, so there the button says what
// is in force and sends the person to Settings to change it.

// Until the plan's list arrives (a cold start of the runtime), the only
// honest choice is the runtime's own default.
const AUTO = ''

export function useModelChoices(): ModelChoiceDto[] {
  const [rows, setRows] = useState<ModelChoiceDto[]>([])
  useEffect(() => {
    const read = () => void api.modelsList().then(setRows).catch(() => {})
    read()
    return api.onEvent((event) => {
      if (event.type === 'models:changed' || event.type === 'engines:detected') read()
    })
  }, [])
  return rows
}

export function ModelPicker() {
  const [engine, setEngine] = useState<'claude' | 'codex' | null>(null)
  const [model, setModel] = useState(AUTO)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const rows = useModelChoices()

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
  const label = engine === 'codex' ? model || t('settings.modelAuto') : (rows.find((r) => r.value === model)?.label ?? (model || t('settings.modelAuto')))
  const choose = (next: string) => {
    setModel(next)
    setOpen(false)
    void api
      .settingsGet()
      .then((s) => api.settingsSet({ ...s, claudeModel: next }))
      .catch(() => {})
  }
  const choices: ModelChoiceDto[] = [{ value: AUTO, label: t('settings.modelAuto'), detail: t('model.autoDetail') }, ...rows]
  return (
    <div className="model-picker" ref={box}>
      <button
        className="model-picker-btn"
        data-testid="model-picker"
        title={t(engine === 'codex' ? 'model.pickChatGPT' : 'model.pick')}
        disabled={engine === 'codex'}
        onClick={() => setOpen(!open)}
      >
        {label}
        {engine === 'claude' && <ChevronDown size={11} strokeWidth={2.2} aria-hidden />}
      </button>
      {open && engine === 'claude' && (
        <div className="model-picker-menu" role="menu" data-testid="model-picker-menu">
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
          {rows.length === 0 && <div className="model-picker-note">{t('model.listing')}</div>}
        </div>
      )}
    </div>
  )
}
