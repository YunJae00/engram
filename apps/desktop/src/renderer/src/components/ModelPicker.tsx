import { Check, ChevronDown, LoaderCircle, Settings } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettingsDto, EngineStatusDto, ModelChoiceDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useShellState } from '../state-slices.js'
import { ProviderIcon } from './ProviderIcon.js'
import type { ReasoningEffort } from 'core'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { AccountProfiles } from './AccountProfiles.js'

type Provider = AppSettingsDto['defaultEngine']
const PROVIDERS = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'ChatGPT' }] as const
const catalogs = new Map<string, { rows: ModelChoiceDto[]; checked: number; pending?: Promise<ModelChoiceDto[]> }>()
const catalogKey = (engine: Provider, profile: string) => profile === 'system' ? engine : `${engine}.${profile}`
function cachedModels(engine: Provider, profile: string): ModelChoiceDto[] {
  const key = catalogKey(engine, profile)
  if (!catalogs.has(key)) {
    let rows: ModelChoiceDto[] = []
    try {
      const saved = JSON.parse(localStorage.getItem(`engram.models.${key}`) ?? 'null')
      if (saved && Date.now() - saved.at < 86_400_000 && Array.isArray(saved.rows)) rows = saved.rows.filter((row: ModelChoiceDto) => row && typeof row.value === 'string' && typeof row.label === 'string' && typeof row.detail === 'string' && (!row.efforts || Array.isArray(row.efforts) && row.efforts.every(level => typeof level === 'string'))).slice(0, 200)
    } catch { /* A missing catalog is loaded from the runtime. */ }
    catalogs.set(key, { rows, checked: 0 })
  }
  return catalogs.get(key)!.rows
}
function readModels(engine: Provider, profile: string, force = false): Promise<ModelChoiceDto[]> {
  cachedModels(engine, profile)
  const key = catalogKey(engine, profile), catalog = catalogs.get(key)!
  if (catalog.pending) return catalog.pending
  if (!force && catalog.rows.length && Date.now() - catalog.checked < 60_000) return Promise.resolve(catalog.rows)
  catalog.pending = api.modelsList(engine, profile).then(rows => {
    catalog.rows = rows; catalog.checked = Date.now()
    try { localStorage.setItem(`engram.models.${key}`, JSON.stringify({ rows, at: catalog.checked })) } catch { /* Memory caching still works without storage. */ }
    return rows
  }).finally(() => { catalog.pending = undefined })
  return catalog.pending
}

export function useModelChoices(engine: Provider | null, pinnedProfile?: string) {
  const profiles = useAccountProfiles(), profile = pinnedProfile ?? (engine ? profiles?.selected[engine] : undefined) ?? 'system'
  const [result, setResult] = useState<{ engine: typeof engine; profile: string; rows: ModelChoiceDto[]; loading: boolean; error: boolean }>({ engine, profile, rows: engine ? cachedModels(engine, profile) : [], loading: true, error: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let serial = 0
    if (!engine) return
    const read = (force = false) => {
      const at = ++serial
      setResult({ engine, profile, rows: cachedModels(engine, profile), loading: true, error: false })
      void readModels(engine, profile, force || attempt > 0).then((rows) => {
        if (alive && at === serial) setResult({ engine, profile, rows, loading: false, error: rows.length === 0 })
      }).catch(() => { if (alive && at === serial) setResult({ engine, profile, rows: cachedModels(engine, profile), loading: false, error: true }) })
    }
    read()
    const off = api.onEvent((event) => { if (event.type === 'models:changed') read(true) })
    return () => { alive = false; off() }
  }, [engine, profile, attempt])
  return { ...(result.engine === engine && result.profile === profile ? result : { rows: engine ? cachedModels(engine, profile) : [], loading: true, error: false }), refresh: () => setAttempt((value) => value + 1) }
}

export interface ModelSelection { engine: Provider; model: string; effort?: ReasoningEffort }
export function ModelPicker({ variant = 'composer', scope, controlled, showAccounts = true }: { variant?: 'composer' | 'sidebar'; scope?: string; showAccounts?: boolean; controlled?: { value: ModelSelection; accountProfile?: string; disabled?: boolean; lockProvider?: boolean; onChange(value: ModelSelection): Promise<void> } }) {
  const { engines, enginesDetected } = useShellState()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [states, setStates] = useState<EngineStatusDto[] | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'model' | 'effort'>('model')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const effortTrigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const focusLast = useRef(false)
  const menuId = useId()
  const selection = controlled?.value ?? (scope ? settings?.aiSelections?.[scope] : undefined)
  const engine = selection?.engine ?? settings?.defaultEngine ?? null
  const model = selection?.model ?? (engine === 'codex' ? settings?.codexModel : settings?.claudeModel) ?? ''
  const effort = selection ? selection.effort : engine === 'codex' ? settings?.codexEffort : settings?.claudeEffort
  const { rows, loading, error, refresh } = useModelChoices(engine, controlled?.accountProfile)
  const sidebar = variant === 'sidebar'

  useEffect(() => {
    if (controlled) return
    let alive = true
    let revision = 0
    void api.settingsGet().then((value) => { if (alive && revision === 0) setSettings(value) }).catch(() => { if (alive) setSaveError('Could not load settings. Open AI settings to retry.') })
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed') { revision++; setSettings(event.settings) }
    })
    return () => { alive = false; off() }
  }, [!!controlled])

  useEffect(() => {
    let alive = true
    let serial = 0
    const read = () => {
      const at = ++serial
      const request = controlled?.accountProfile ? api.accountProfileStates().then(rows => rows.filter(row => row.id === controlled.accountProfile).map(row => ({ ...row, id: row.provider }))) : api.engineStates()
      void request.then((next) => { if (alive && at === serial) setStates(next) }).catch(() => {
        if (alive && at === serial) setSaveError('Could not check connections. Open AI settings to retry.')
      })
    }
    if (open || !states) read()
    const off = api.onEvent((event) => {
      if (event.type === 'engines:detected' || event.type === 'engines:changed' || event.type === 'engines:login' || event.type === 'accounts:changed') read()
    })
    return () => { alive = false; off() }
  }, [open, controlled?.accountProfile])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!box.current || !menu.current) return
      const anchor = (mode === 'effort' ? effortTrigger.current : trigger.current)?.getBoundingClientRect() ?? box.current.getBoundingClientRect()
      if (!anchor.width) { setOpen(false); return }
      const host = box.current.closest('.dev-pane, .mini-chat, .bots-chat, .cosmos-chat, .bots-main')?.getBoundingClientRect()
      const left = Math.max(0, host?.left ?? 0) + 8
      const right = Math.min(innerWidth, host?.right ?? innerWidth) - 8
      const width = Math.max(0, Math.min(mode === 'effort' && !controlled ? 172 : 264, right - left))
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
  }, [open, mode])

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
        ;(mode === 'effort' ? effortTrigger.current : trigger.current)?.focus()
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
  }, [open, mode])

  const setup = () => {
    setOpen(false)
    window.dispatchEvent(new Event('engram:open-brain-setup'))
  }
  const save = async (change: Partial<AppSettingsDto>, close: boolean) => {
    if (saving || controlled?.disabled) return
    setSaving(true)
    setSaveError('')
    try {
      if (controlled) {
        const chosen: ModelSelection = { engine: change.defaultEngine ?? controlled.value.engine, model: change.defaultEngine ? '' : change.codexModel ?? change.claudeModel ?? model, effort: change.defaultEngine || 'codexModel' in change || 'claudeModel' in change ? undefined : 'codexEffort' in change ? change.codexEffort : 'claudeEffort' in change ? change.claudeEffort : effort }
        await controlled.onChange(chosen)
        if (close) { setOpen(false); (mode === 'effort' ? effortTrigger.current : trigger.current)?.focus() }
        return
      }
      const current = settings ?? await api.settingsGet()
      const next = { ...current, ...change }
      if ('claudeModel' in change) next.claudeEffort = undefined
      if ('codexModel' in change) next.codexEffort = undefined
      if (scope) {
        const provider = change.defaultEngine ?? engine ?? current.defaultEngine
        const chosen = { engine: provider, model: change.defaultEngine ? '' : (change.codexModel ?? change.claudeModel ?? model), effort: change.defaultEngine || 'codexModel' in change || 'claudeModel' in change ? undefined : 'codexEffort' in change ? change.codexEffort : 'claudeEffort' in change ? change.claudeEffort : effort }
        await api.aiSelectionSet(scope, chosen)
        setSettings(value => value ? { ...value, aiSelections: { ...value.aiSelections, [scope]: chosen } } : value)
      } else { await api.settingsSet(next); setSettings(next) }
      if (close) { setOpen(false); (mode === 'effort' ? effortTrigger.current : trigger.current)?.focus() }
    } catch { setSaveError('Could not save your selection. Try again.') }
    finally { setSaving(false) }
  }
  const stateFor = (id: Provider) => states?.find((one) => one.id === id) ?? engines.find((one) => one.id === id)
  const selectedState = engine ? stateFor(engine) : undefined
  const selectedHealth = engines.find((one) => one.id === engine)
  const providerName = PROVIDERS.find((one) => one.id === engine)?.name ?? 'AI'
  const status = selectedHealth?.healthy === false ? 'Needs attention' : selectedState?.loggedIn ? 'Connected' : !states && !enginesDetected ? 'Checking connection…' : 'Connect'
  const modelLabel = rows.find((row) => row.value === model)?.label ?? (model || t('settings.modelAuto'))
  const label = modelLabel
  const efforts = rows.find(row => row.value === model)?.efforts ?? []
  const effortLabel = (level?: string) => level ? level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1) : 'Auto'
  const choices: ModelChoiceDto[] = [{ value: '', label: t('settings.modelAuto'), detail: t('model.autoDetail') }, ...rows, ...(model && !rows.some(row => row.value === model) ? [{ value: model, label: model, detail: 'Saved selection' }] : [])]

  if (!settings && !controlled) return <div className="model-picker" role="status" aria-label="Loading model selection"><LoaderCircle size={16} className="computer-spinner" aria-hidden /><span className="skeleton-line" style={{ width: 92 }} />{saveError && <button onClick={setup}>Open AI settings</button>}</div>

  return <div className={`model-picker${sidebar ? ' provider-picker-sidebar' : ''}`} ref={box}>
    <button type="button" ref={trigger} disabled={controlled?.disabled} aria-disabled={saving || undefined} className={sidebar ? 'sidebar-status-row sidebar-engine-status' : 'model-picker-btn'}
      data-testid={sidebar ? 'engine-status' : 'model-picker'} title={`${providerName} · ${sidebar ? status : label} · Choose provider and model`}
      aria-label={`${providerName} · ${sidebar ? status : label} · Choose provider and model`} aria-expanded={open && mode === 'model'} aria-haspopup="menu" aria-controls={open && mode === 'model' ? menuId : undefined}
      onClick={() => { if (saving) return; focusLast.current = false; setMode('model'); setOpen(!open || mode !== 'model') }}
      onKeyDown={(event) => { if (saving) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setMode('model'); setOpen(true) } }}>
      {saving ? <LoaderCircle size={16} className="computer-spinner" aria-hidden /> : <ProviderIcon provider={engine ?? 'claude'} size={16} />}
      {sidebar ? <span className="provider-picker-status"><span>{providerName}</span><small>{scope === 'filing' ? `Filing · ${status}` : status}</small></span> : <span className="provider-picker-label">{label}{controlled && effort ? ` · ${effortLabel(effort)}` : ''}</span>}
      <ChevronDown className="provider-picker-chevron" size={sidebar ? 12 : 16} strokeWidth={1.8} aria-hidden />
    </button>
    {!sidebar && !controlled && efforts.length > 0 && <button type="button" ref={effortTrigger} className="model-picker-btn effort-picker-btn" data-testid="effort-picker" aria-label={`Reasoning effort: ${effortLabel(effort)}`} title="Reasoning effort" aria-haspopup="menu" aria-controls={open && mode === 'effort' ? menuId : undefined} aria-expanded={open && mode === 'effort'} onClick={() => { focusLast.current = false; setMode('effort'); setOpen(!open || mode !== 'effort') }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setMode('effort'); setOpen(true) } }}><span>{effortLabel(effort)}</span><ChevronDown size={16} aria-hidden /></button>}
    {showAccounts && !sidebar && engine && <AccountProfiles provider={engine} compact sessionProfile={controlled?.accountProfile} />}
    {open && createPortal(<div className="model-picker-menu provider-picker-menu" ref={menu} id={menuId} role="menu" aria-label={mode === 'effort' ? 'Reasoning effort' : 'Provider and model'} data-testid={mode === 'effort' ? 'effort-picker-menu' : sidebar ? 'provider-picker-menu' : 'model-picker-menu'} aria-busy={saving}>
      {mode === 'model' ? <>
      <div className="provider-picker-heading">{controlled ? 'This session' : scope === 'filing' ? 'Filing provider' : scope ? 'This conversation' : 'New conversations'}</div>
      {PROVIDERS.map(({ id, name }) => {
        const state = stateFor(id)
        const connected = state?.loggedIn === true
        const detail = connected ? 'Connected' : !states && !state ? 'Open AI settings' : state?.installed ? 'Connect in settings' : 'Set up in settings'
        return <button type="button" key={id} role="menuitemradio" aria-checked={engine === id} tabIndex={-1} disabled={saving || controlled?.disabled || (controlled?.lockProvider && engine !== id)} className="model-picker-item provider-picker-option" data-testid={`provider-pick-${id}`}
          onClick={() => { if (!connected) setup(); else if (engine !== id) void save({ defaultEngine: id }, false) }}>
          <ProviderIcon provider={id} size={18} /><span className="model-picker-name" title={detail}>{name}{!connected && <span className="model-picker-detail">Connect</span>}</span>
          {engine === id && <Check className="provider-picker-check" size={14} aria-hidden />}
        </button>
      })}
      <div className="provider-picker-divider" role="separator" />
      <div className="provider-picker-heading">{providerName} models</div>
      {choices.map((row) => <button type="button" key={row.value || 'auto'} role="menuitemradio" aria-checked={model === row.value} tabIndex={-1} disabled={saving || !engine}
        className="model-picker-item" title={row.detail} data-testid={`model-pick-${row.value || 'auto'}`}
        onClick={() => { if (engine) void save({ [engine === 'codex' ? 'codexModel' : 'claudeModel']: row.value }, !controlled) }}>
        <span className="model-picker-tick">{model === row.value && <Check size={12} strokeWidth={2.4} aria-hidden />}</span>
        <span className="model-picker-name">{row.label}</span>
      </button>)}
      {loading && <div className="model-picker-note inline-loading" role="status"><LoaderCircle size={14} className="computer-spinner" aria-hidden />{rows.length ? 'Updating models…' : 'Loading models…'}</div>}
      {loading && !rows.length && <div className="model-loading-skeleton" aria-hidden>{[0, 1, 2].map(index => <span key={index} className="skeleton-line" />)}</div>}
      {error && <button type="button" className="model-picker-item" role="menuitem" tabIndex={-1} onClick={refresh}>Models unavailable · Retry</button>}
      {controlled && efforts.length > 0 && <><div className="provider-picker-divider" role="separator" /><div className="provider-picker-heading">Reasoning effort</div><div className="dev-effort-scale">{[undefined, ...efforts].map(level => <button key={level ?? 'auto'} type="button" className="model-picker-item" role="menuitemradio" tabIndex={-1} aria-checked={effort === level} disabled={saving || controlled.disabled} data-testid={`effort-pick-${level ?? 'auto'}`} onClick={() => { if (engine) void save({ [engine === 'codex' ? 'codexEffort' : 'claudeEffort']: level }, true) }}><span className="model-picker-name">{effortLabel(level)}</span>{effort === level && <Check size={14} aria-hidden />}</button>)}</div></>}
      <div className="provider-picker-divider" role="separator" />
      <button type="button" className="model-picker-item provider-picker-settings" role="menuitem" tabIndex={-1} onClick={setup}><Settings size={14} aria-hidden />AI settings</button>
      </> : <><div className="provider-picker-heading">Reasoning effort</div>{controlled && <p className="model-picker-note">Choose how much time the model spends reasoning.</p>}<div className={controlled ? 'dev-effort-scale' : undefined}>{[undefined, ...efforts].map(level => <button key={level ?? 'auto'} type="button" className="model-picker-item" role="menuitemradio" tabIndex={-1} aria-checked={effort === level} disabled={saving || controlled?.disabled} data-testid={`effort-pick-${level ?? 'auto'}`} onClick={() => { if (engine) void save({ [engine === 'codex' ? 'codexEffort' : 'claudeEffort']: level }, true) }}><span className="model-picker-name">{effortLabel(level)}</span>{effort === level && <Check size={14} aria-hidden />}</button>)}</div></>}
      {saveError && <div className="model-picker-note" role="alert">{saveError}</div>}
    </div>, document.body)}
  </div>
}
