import { useEffect, useState, type ReactNode } from 'react'
import type { BotDto, DelegatedTaskDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, uiLanguage } from '../i18n.js'
import { useApp } from '../state.js'
import { useShellState } from '../state-slices.js'
import { formatRun, routineRows, runHistory } from '../lib/botRoutines.js'

const RUN_LABEL = { running: 'botInfo.runRunning', succeeded: 'botInfo.runSucceeded', failed: 'botInfo.runFailed' } as const

export function BotRoutinesTab({ bot, empty }: { bot: BotDto; empty: ReactNode }) {
  const { startRoutine } = useApp()
  const { showToast } = useShellState()
  const [runs, setRuns] = useState<DelegatedTaskDto[]>([])
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const load = () => void api.tasksList().then(setRuns).catch(() => undefined)
    load()
    return api.onEvent(event => { if (event.type === 'tasks:changed') load() })
  }, [])
  const rows = routineRows(bot.tasks, new Date())
  const history = runHistory(runs, bot.id)
  if (!rows.length && !history.length) return empty
  const remove = (id: string) => {
    if (armed !== id) { setArmed(id); return }
    setArmed(null)
    void api.botTaskRemove(bot.id, id).catch((error: unknown) => showToast(String(error)))
  }
  const togglePause = (id: string, paused: boolean) => {
    setBusy(prev => new Set(prev).add(id))
    void api.botTaskPause(bot.id, id, !paused)
      .catch((error: unknown) => showToast(String(error)))
      .finally(() => setBusy(prev => { const next = new Set(prev); next.delete(id); return next }))
  }
  return (
    <div data-testid="bot-routines">
      <ul>
        {rows.map(row => (
          <li key={row.id} data-testid={`bot-routine-${row.id}`}>
            <strong>{row.name}</strong>
            {row.paused ? <span data-testid="bot-routine-paused">{t('botInfo.paused')}</span>
              : <span>{row.next ? t('botInfo.nextRun', { when: formatRun(row.next, uiLanguage()) }) : t('botInfo.noNextRun')}</span>}
            <div>
              {row.routineId !== null && <>
                <button type="button" className="secondary" onClick={() => { if (row.routineId) void startRoutine(row.routineId, row.name) }}>{t('botInfo.test')}</button>
                <button type="button" className="secondary" onClick={() => window.dispatchEvent(new Event('engram:open-routines'))}>{t('botInfo.edit')}</button>
              </>}
              <button type="button" className="secondary" data-testid={`bot-routine-pause-${row.id}`} disabled={busy.has(row.id)} onClick={() => togglePause(row.id, row.paused)}>{row.paused ? t('botInfo.resume') : t('botInfo.pause')}</button>
              <button type="button" className="secondary" onClick={() => remove(row.id)}>{armed === row.id ? t('routines.deleteArmed') : t('botInfo.delete')}</button>
            </div>
          </li>
        ))}
      </ul>
      {history.length > 0 && (
        <section aria-label={t('botInfo.history')}>
          <h3>{t('botInfo.history')}</h3>
          <ol>
            {history.map(run => (
              <li key={run.id} data-state={run.state}>
                <span>{t(RUN_LABEL[run.state])}</span>
                <time dateTime={run.at}>{formatRun(new Date(Date.parse(run.at)), uiLanguage())}</time>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
