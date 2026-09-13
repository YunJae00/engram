import { Check, ChevronDown, Settings } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettingsDto, EngineStatusDto, ModelChoiceDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useShellState } from '../state-slices.js'
import { ProviderIcon } from './ProviderIcon.js'

type Provider = AppSettingsDto['defaultEngine']
const PROVIDERS = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }] as const

export function useModelChoices(engine: Provider | null) {
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
    const off = api.onEvent((event) => { if (event.type === 'models:changed') read() })
    return () => { alive = false; off() }
  }, [engine, attempt])
  return { ...(result.engine === engine ? result : { rows: [], loading: true, error: false }), refresh: () => setAttempt((value) => value + 1) }
}

export function ModelPicker({ variant = 'composer' }: { variant?: 'composer' | 'sidebar' }) {
  const { engines, enginesDetected } = useShellState()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [states, setStates] = useState<EngineStatusDto[] | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const focusLast = useRef(false)
  const menuId = useId()
  const engine = settings?.defaultEngine ?? null
  const model = (engine === 'codex' ? settings?.codexModel : settings?.claudeModel) ?? ''
  const { rows, loading, error, refresh } = useModelChoices(engine)
  const sidebar = variant === 'sidebar'

  useEffect(() => {
    let alive = true
    let revision = 0
    void api.settingsGet().then((value) => { if (alive && revision === 0) setSettings(value) }).catch(() => { if (alive) setSaveError('Could not load settings. Open AI settings to retry.') })
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed') { revision++; setSettings(event.settings) }
      if (event.type === 'engines:changed' || event.type === 'engines:login') setStates(null)
    })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    let serial = 0
    const read = () => {
      const at = ++serial
      void api.engineStates().then((next) => { if (alive && at === serial) setStates(next) }).catch(() => {
        if (alive && at === serial) setSaveError('Could not check connections. Open AI settings to retry.')
      })
    }
    read()
    const off = api.onEvent((event) => {
      if (event.type === 'engines:detected' || event.type === 'engines:changed' || event.type === 'engines:login') read()
    })
    return () => { alive = false; off() }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!box.current || !menu.current) return
      const anchor = box.current.getBoundingClientRect()
      if (!anchor.width) { setOpen(false); return }
      const host = box.current.closest('.bots-chat, .cosmos-chat, .bots-main')?.getBoundingClientRect()
      const left = Math.max(0, host?.left ?? 0) + 8
      const right = Math.min(innerWidth, host?.right ?? innerWidth) - 8
      const width = Math.max(0, Math.min(300, right - left))
      const above = Math.max(0, anchor.top - Math.max(8, host?.top ?? 8) - 6)
      const below = Math.max(0, Math.min(innerHeight - 8, host?.bottom ?? innerHeight - 8) - anchor.bottom - 6)
      const down = below > above
      Object.assign(menu.current.style, {
        width: `${width}px`, left: `${Math.max(left, Math.min(anchor.left, right - width))}px`,
        maxHeight: `${Math.min(420, down ? below : above)}px`,
        top: down ? `${anchor.bottom + 6}px` : 'auto', bottom: down ? 'auto' : `${innerHeight - anchor.top + 6}px`,
        transformOrigin: down ? 'top left' : 'bottom left',
      })
    }
    place()
    const observer = new ResizeObserver(place)
    if (box.current) observer.observe(box.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
    const buttons = items()
    ;(focusLast.current ? buttons.at(-1) : buttons[0])?.focus()
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
        setOpen(false)
        trigger.current?.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const choices = items()
        const index = choices.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
        choices[next]?.focus()
      }
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true) }
  }, [open])

  const setup = () => {
    setOpen(false)
    window.dispatchEvent(new Event('engram:open-brain-setup'))
  }
  const save = async (change: Partial<AppSettingsDto>, close: boolean) => {
    if (saving) return
    setSaving(true)
    setSaveError('')
    try {
      const current = await api.settingsGet()
      const next = { ...current, ...change }
      await api.settingsSet(next)
      setSettings(next)
      if (close) { setOpen(false); trigger.current?.focus() }
    } catch { setSaveError('Could not save your selection. Try again.') }
    finally { setSaving(false) }
  }
  const stateFor = (id: Provider) => states?.find((one) => one.id === id) ?? engines.find((one) => one.id === id)
  const selectedState = engine ? stateFor(engine) : undefined
  const selectedHealth = engines.find((one) => one.id === engine)
  const providerName = PROVIDERS.find((one) => one.id === engine)?.name ?? 'AI'
  const status = selectedHealth?.healthy === false ? 'Needs attention' : selectedState?.loggedIn ? 'Connected' : !states && !enginesDetected ? 'Checking connection…' : 'Connect'
  const label = rows.find((row) => row.value === model)?.label ?? (model || t('settings.modelAuto'))
  const choices: ModelChoiceDto[] = [{ value: '', label: t('settings.modelAuto'), detail: t('model.autoDetail') }, ...rows]

  return <div className={`model-picker${sidebar ? ' provider-picker-sidebar' : ''}`} ref={box}>
    <button type="button" ref={trigger} className={sidebar ? 'sidebar-status-row sidebar-engine-status' : 'model-picker-btn'}
      data-testid={sidebar ? 'engine-status' : 'model-picker'} title={`${providerName} · ${sidebar ? status : label} · Choose provider and model`}
      aria-label={`${providerName} · ${sidebar ? status : label} · Choose provider and model`} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? menuId : undefined}
      onClick={() => { focusLast.current = false; setOpen(!open) }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setOpen(true) } }}>
      <ProviderIcon provider={engine ?? 'claude'} size={sidebar ? 16 : 14} />
      {sidebar ? <span className="provider-picker-status"><span>{providerName}</span><small>{status}</small></span> : <span className="provider-picker-label">{label}</span>}
      <ChevronDown className="provider-picker-chevron" size={12} strokeWidth={1.8} aria-hidden />
    </button>
    {open && createPortal(<div className="model-picker-menu provider-picker-menu" ref={menu} id={menuId} role="menu" aria-label="Provider and model" data-testid={sidebar ? 'provider-picker-menu' : 'model-picker-menu'} aria-busy={saving}>
      <div className="provider-picker-heading">Provider</div>
      {PROVIDERS.map(({ id, name }) => {
        const state = stateFor(id)
        const connected = state?.loggedIn === true
        const detail = connected ? 'Connected' : !states && !state ? 'Open AI settings' : state?.installed ? 'Connect in settings' : 'Set up in settings'
        return <button type="button" key={id} role="menuitemradio" aria-checked={engine === id} tabIndex={-1} disabled={saving} className="model-picker-item provider-picker-option" data-testid={`provider-pick-${id}`}
          onClick={() => { if (!connected) setup(); else if (engine !== id) void save({ defaultEngine: id }, false) }}>
          <ProviderIcon provider={id} size={18} /><span className="model-picker-name">{name}<span className="model-picker-detail">{detail}</span></span>
          {engine === id && <Check className="provider-picker-check" size={14} aria-hidden />}
        </button>
      })}
      <div className="provider-picker-divider" role="separator" />
      <div className="provider-picker-heading">{providerName} models</div>
      {choices.map((row) => <button type="button" key={row.value || 'auto'} role="menuitemradio" aria-checked={model === row.value} tabIndex={-1} disabled={saving || !engine}
        className="model-picker-item" title={row.detail} data-testid={`model-pick-${row.value || 'auto'}`}
        onClick={() => { if (engine) void save({ [engine === 'codex' ? 'codexModel' : 'claudeModel']: row.value }, true) }}>
        <span className="model-picker-tick">{model === row.value && <Check size={12} strokeWidth={2.4} aria-hidden />}</span>
        <span className="model-picker-name">{row.label}{row.detail && <span className="model-picker-detail">{row.detail}</span>}</span>
      </button>)}
      {loading && <div className="model-picker-note" role="status">Loading models…</div>}
      {error && <button type="button" className="model-picker-item" role="menuitem" tabIndex={-1} onClick={refresh}>Models unavailable · Retry</button>}
      {saveError && <div className="model-picker-note" role="alert">{saveError}</div>}
      <div className="provider-picker-divider" role="separator" />
      <button type="button" className="model-picker-item provider-picker-settings" role="menuitem" tabIndex={-1} onClick={setup}><Settings size={14} aria-hidden />AI settings</button>
    </div>, document.body)}
  </div>
}
