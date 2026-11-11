import { AppWindow, ChevronRight, RefreshCw, Route } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppUseDto, HabitDraftDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { renderMarkdown } from '../lib/markdown.js'
import { SettingsGroup, SettingsItem } from './SettingsLayout.js'

const SHOWN = 8

const days = (count: number): string => t(count === 1 ? 'settingsUi.dayOne' : 'settingsUi.dayMany', { count })
const notes = (count: number): string => t(count === 1 ? 'settingsUi.noteOne' : 'settingsUi.noteMany', { count })
const appUse = (app: AppUseDto): string => t('settingsUi.lastMonth', { usage: [app.days ? `${t('settingsUi.appHours', { hours: app.hours })} · ${days(app.days)}` : '', app.notes ? notes(app.notes) : ''].filter(Boolean).join(' · ') })

// The apps used lately, each one Engram may learn from and work in or not,
// and the ways of working noticed in them, waiting for the person to say
// whether each is right before it is kept.
export function WorkHabitsSettings() {
  const [apps, setApps] = useState<AppUseDto[] | null>(null)
  const [drafts, setDrafts] = useState<HabitDraftDto[]>([])
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => {
      void api.appsList().then(next => { if (alive) setApps(next) }).catch(() => { if (alive) setApps([]) })
      void api.habitsList().then(next => { if (alive) setDrafts(next) }).catch(() => undefined)
    }
    load()
    const off = api.onEvent(event => { if (event.type === 'habits:changed' || event.type === 'settings:changed') load() })
    return () => { alive = false; off() }
  }, [])
  const run = async (key: string, work: () => Promise<void>, failed: string) => {
    setBusy(key); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error && cause.message ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : failed) } finally { setBusy('') }
  }
  const toggle = (app: AppUseDto, on: boolean) => run(`app:${app.app}`, async () => {
    await api.appsSet(app.app, app.label, on)
    setApps(current => current?.map(one => one.app === app.app ? { ...one, on } : one) ?? null)
  }, t('settingsUi.saveSettingFailed'))
  const scan = () => run('scan', async () => setDrafts(await api.habitsScan()), t('settingsUi.lookFailed'))
  const answer = (draft: HabitDraftDto, keep: boolean) => run(draft.key, async () => setDrafts(await api.habitsAnswer(draft.key, keep)), t('settingsUi.answerFailed'))
  const shown = all ? apps ?? [] : (apps ?? []).slice(0, SHOWN)
  return <>
    <SettingsGroup title={t('settingsUi.appsTitle')} testId="apps-settings" note={t('settingsUi.appsNote')}>
      {apps === null && <SettingsItem title={t('settingsUi.loading')} />}
      {apps?.length === 0 && <SettingsItem icon={<AppWindow size={18} />} title={t('settingsUi.noApps')} description={t('settingsUi.noAppsHint')} />}
      {shown.map(app => <SettingsItem key={app.app} icon={app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <AppWindow size={18} />} title={app.label} htmlFor={`app-${app.app}`} testId={`app-row-${app.app}`}
        description={app.on ? appUse(app) : t('settingsUi.turnedOff')}>
        <input id={`app-${app.app}`} type="checkbox" className="switch" data-testid={`app-on-${app.app}`} aria-label={t('settingsUi.letUse', { app: app.label })} checked={app.on} disabled={busy === `app:${app.app}`} onChange={event => void toggle(app, event.target.checked)} />
      </SettingsItem>)}
      {(apps?.length ?? 0) > SHOWN && <SettingsItem title={all ? t('settingsUi.showFewer') : t('settingsUi.showAll', { count: apps!.length })}><button type="button" className="secondary" data-testid="apps-more" onClick={() => setAll(!all)}>{all ? t('settingsUi.fewer') : t('settingsUi.all')}</button></SettingsItem>}
    </SettingsGroup>
    <SettingsGroup title={t('settingsUi.habitsTitle')} testId="habits-settings" note={t('settingsUi.habitsNote')}>
      <SettingsItem icon={<Route size={18} />} title={drafts.length ? t('settingsUi.toCheck', { count: drafts.length }) : t('settingsUi.nothingToCheck')} description={drafts.length ? t('settingsUi.isThisHow') : t('settingsUi.habitsHint')}>
        <button type="button" className="settings-icon-action" data-testid="habits-scan" aria-label={t('settingsUi.lookNow')} title={t('settingsUi.lookNow')} disabled={busy === 'scan'} onClick={() => void scan()}><RefreshCw size={14} className={busy === 'scan' ? 'computer-spinner' : undefined} aria-hidden /></button>
      </SettingsItem>
      {drafts.map(draft => <SettingsItem key={draft.key} testId="habit-draft" title={draft.title}
        description={<>{draft.labels.join(' → ')} · {t('settingsUi.times', { count: draft.times })}<br />{draft.description}</>}
        below={<details className="habit-draft-body"><summary><ChevronRight size={13} aria-hidden />{t('settingsUi.howTo')}</summary><div className="bubble-msg-body">{renderMarkdown(draft.body)}</div></details>}>
        <button type="button" className="secondary" data-testid="habit-dismiss" disabled={busy === draft.key} onClick={() => void answer(draft, false)}>{t('settingsUi.notRight')}</button>
        <button type="button" className="primary" data-testid="habit-keep" disabled={busy === draft.key} onClick={() => void answer(draft, true)}>{t('settingsUi.keep')}</button>
      </SettingsItem>)}
    </SettingsGroup>
    {error && <p className="computer-error" role="alert">{error}</p>}
  </>
}
