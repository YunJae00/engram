import { Activity, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DiagnosticsDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DialogHeader } from '../components/DialogHeader.js'

export function DiagnosticsView({ onClose }: { onClose(): void }) {
  const { showToast, t } = useApp()
  const [info, setInfo] = useState<DiagnosticsDto | null>(null)
  const readyRef = useRef<Map<string, boolean>>(new Map())
  const firstPollRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        await api.enginesRefresh()
        const next = await api.diagnostics()
        if (cancelled) return
        for (const engine of next.engines) {
          const ready = engine.installed && engine.loggedIn && engine.healthy !== false
          const was = readyRef.current.get(engine.id)
          if (ready && was === false && !firstPollRef.current) showToast(t('toast.engineReady', { id: engine.id }))
          readyRef.current.set(engine.id, ready)
        }
        firstPollRef.current = false
        setInfo(next)
      } catch {
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [showToast, t])

  useEscape(onClose)

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div
        className="brief-box diagnostics-box"
        onClick={(e) => e.stopPropagation()}
        data-testid="diagnostics-view"
      >
        <DialogHeader closeLabel={t('diag.close')} icon={<Activity size={16} aria-hidden />} onClose={onClose}>
          {t('diag.title')}
        </DialogHeader>

        {!info && <p>{t('diag.checking')}</p>}
        {info && (
          <>
            {info.apiKeyEnvWarnings.length > 0 && (
              <div className="engine-banner">
                <TriangleAlert className="warn-icon" size={12} strokeWidth={1.8} aria-hidden />
                {t('diag.apiKeyWarning', { keys: info.apiKeyEnvWarnings.join(', ') })}
              </div>
            )}
            <ul className="engine-lights">
              {info.engines.map((engine) => {
                const ready = engine.installed && engine.loggedIn && engine.healthy !== false
                return (
                  <li key={engine.id} className={ready ? 'engine-ready' : ''}>
                    <span className={`engine-dot${ready ? ' on' : engine.installed ? ' warn' : ''}`} />
                    <span className="engine-name">{engine.label ?? engine.id}</span>
                    {ready ? (
                      <span className="engine-pill">{t('diag.connected')}</span>
                    ) : (
                      <span className="side-sub">{engine.diagnosis}</span>
                    )}
                  </li>
                )
              })}
              <li>
                <span className={`engine-dot${info.sync.state !== 'error' ? ' on' : ''}`} />
                {t('diag.teamSync')}
                <span className="side-sub">{info.sync.state === 'no-remote' ? t('diag.noTeam') : info.sync.state}</span>
              </li>
              <li>
                <span className={`engine-dot${info.bundledGit ? ' on' : ' warn'}`} />
                {t('diag.bundledGit')}
                <span className="side-sub">{info.bundledGit ? t('diag.gitReady') : t('diag.gitSystem')}</span>
              </li>
            </ul>
            <div className="dialog-actions">
              <button
                className="secondary"
                onClick={() =>
                  void api
                    .exportLogs()
                    .then((p) =>
                      showToast(p ? t('toast.logsExported', { path: p }) : t('toast.logsEmpty')),
                    )
                    .catch((err: unknown) => showToast(t('toast.actionFailed', { reason: String((err as Error).message ?? err).slice(0, 120) })))
                }
              >
                {t('diag.exportLogs')}
              </button>
              <button className="primary" onClick={onClose}>
                {t('diag.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
