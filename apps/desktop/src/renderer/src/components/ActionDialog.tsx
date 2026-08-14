import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import type { PaletteAction } from './Palette.js'

export function ActionDialog({ action, onClose }: { action: PaletteAction | null; onClose(): void }) {
  const { showToast, refresh, t } = useApp()
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<'input' | 'confirm' | 'running'>('input')
  const [scan, setScan] = useState<{ folder: string; count: number; totalBytes: number } | null>(null)

  useEscape(onClose, action !== null)

  useEffect(() => {
    setValue('')
    setPhase('input')
    setScan(null)
    if (action === 'import') {
      void (async () => {
        const folder = await api.importPick()
        if (!folder) {
          onClose()
          return
        }
        const preview = await api.importScan(folder)
        setScan({ folder, ...preview })
        setPhase('confirm')
      })()
    }
  }, [action]) // re-run per action only

  if (!action) return null

  const submitTeam = async () => {
    if (!value.trim()) return
    setPhase('running')
    try {
      await api.teamJoin(value.trim())
      showToast(t('toast.teamJoined'))
      await refresh()
      onClose()
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err))
      onClose()
    }
  }

  const runImport = async () => {
    if (!scan) return
    setPhase('running')
    const report = await api.importRun(scan.folder)
    showToast(t('toast.imported', { count: report.imported }))
    await refresh()
    onClose()
  }

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box" onClick={(e) => e.stopPropagation()}>
        {action === 'import' ? (
          <>
            <div className="brief-title">{t('palette.importTitle')}</div>
            {phase === 'confirm' && scan ? (
              <>
                <p>
                  {t('palette.importCount', { count: scan.count, kb: (scan.totalBytes / 1024).toFixed(0) })}
                  <br />
                  <code>{scan.folder}</code>
                </p>
                <p className="side-sub">{t('palette.importNote')}</p>
                <div className="dialog-actions">
                  <button className="primary" data-testid="import-confirm" onClick={() => void runImport()}>
                    {t('palette.importAction')}
                  </button>
                  <button className="secondary" onClick={onClose}>
                    {t('palette.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <p>{phase === 'running' ? t('palette.importing') : t('palette.choosingFolder')}</p>
            )}
          </>
        ) : (
          <>
            <div className="brief-title">{t('palette.teamJoinTitle')}</div>
            {phase === 'running' ? (
              <p>{t('palette.working')}</p>
            ) : (
              <>
                <input
                  autoFocus
                  placeholder={t('palette.invitePlaceholder')}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submitTeam()}
                />
                <div className="dialog-actions">
                  <button className="primary" onClick={() => void submitTeam()}>
                    {t('palette.join')}
                  </button>
                  <button className="secondary" onClick={onClose}>
                    {t('palette.cancel')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
