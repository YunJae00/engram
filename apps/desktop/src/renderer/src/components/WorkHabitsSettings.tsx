import { AppWindow, ChevronRight, RefreshCw, Route } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppUseDto, HabitDraftDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { renderMarkdown } from '../lib/markdown.js'
import { SettingsGroup, SettingsItem } from './SettingsLayout.js'

const SHOWN = 8

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
    setApps(current => current?.map(one => one.app === app.app ? { ...one, on } : one) ?? null)
    await api.appsSet(app.app, app.label, on)
  }, 'Could not save the setting.')
  const scan = () => run('scan', async () => setDrafts(await api.habitsScan()), 'Could not look this time. Try again later.')
  const answer = (draft: HabitDraftDto, keep: boolean) => run(draft.key, async () => setDrafts(await api.habitsAnswer(draft.key, keep)), 'Could not save your answer.')
  const shown = all ? apps ?? [] : (apps ?? []).slice(0, SHOWN)
  return <>
    <SettingsGroup title="Apps Engram may use" testId="apps-settings" note="An app turned off is not recorded, learned from or worked in.">
      {apps === null && <SettingsItem title="Loading…" />}
      {apps?.length === 0 && <SettingsItem icon={<AppWindow size={18} />} title="No apps yet" description="Apps appear here as you use them while Engram is open." />}
      {shown.map(app => <SettingsItem key={app.app} icon={<AppWindow size={18} />} title={app.label} htmlFor={`app-${app.app}`} testId={`app-row-${app.app}`}
        description={app.days ? `${app.hours} h · ${app.days} ${app.days === 1 ? 'day' : 'days'} in the last 30` : 'Turned off'}>
        <input id={`app-${app.app}`} type="checkbox" className="switch" data-testid={`app-on-${app.app}`} aria-label={`Let Engram use ${app.label}`} checked={app.on} disabled={busy === `app:${app.app}`} onChange={event => void toggle(app, event.target.checked)} />
      </SettingsItem>)}
      {(apps?.length ?? 0) > SHOWN && <SettingsItem title={all ? 'Show fewer' : `Show all ${apps!.length}`}><button type="button" className="secondary" data-testid="apps-more" onClick={() => setAll(!all)}>{all ? 'Fewer' : 'All'}</button></SettingsItem>}
    </SettingsGroup>
    <SettingsGroup title="Ways of working noticed" testId="habits-settings" note="Kept ones are how-tos your AI follows when the same job comes up.">
      <SettingsItem icon={<Route size={18} />} title={drafts.length ? `${drafts.length} to check` : 'Nothing to check'} description={drafts.length ? 'Is this how you do it?' : 'When you go through the same apps for one job a few times, a how-to is drafted here.'}>
        <button type="button" className="settings-icon-action" data-testid="habits-scan" aria-label="Look now" title="Look now" disabled={busy === 'scan'} onClick={() => void scan()}><RefreshCw size={14} className={busy === 'scan' ? 'computer-spinner' : undefined} aria-hidden /></button>
      </SettingsItem>
      {drafts.map(draft => <SettingsItem key={draft.key} testId="habit-draft" title={draft.title}
        description={<>{draft.labels.join(' → ')} · {draft.times} times<br />{draft.description}</>}
        below={<details className="habit-draft-body"><summary><ChevronRight size={13} aria-hidden />How-to</summary><div className="bubble-msg-body">{renderMarkdown(draft.body)}</div></details>}>
        <button type="button" className="secondary" data-testid="habit-dismiss" disabled={busy === draft.key} onClick={() => void answer(draft, false)}>Not right</button>
        <button type="button" className="primary" data-testid="habit-keep" disabled={busy === draft.key} onClick={() => void answer(draft, true)}>Keep</button>
      </SettingsItem>)}
    </SettingsGroup>
    {error && <p className="computer-error" role="alert">{error}</p>}
  </>
}
