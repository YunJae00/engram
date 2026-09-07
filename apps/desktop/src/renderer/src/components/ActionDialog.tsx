import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import type { PaletteAction } from './Palette.js'
import { DialogHeader } from './DialogHeader.js'

export function ActionDialog({ action, onClose }: { action: PaletteAction | null; onClose(): void }) {
  const { showToast, refresh, t } = useApp()
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<'input' | 'running'>('input')

  useEscape(onClose, action !== null)

  useEffect(() => {
    setValue('')
    setPhase('input')
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

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box" onClick={(e) => e.stopPropagation()}>
        <DialogHeader closeLabel={t('palette.cancel')} onClose={onClose}>{t('palette.teamJoinTitle')}</DialogHeader>
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
              <button className="secondary" onClick={onClose}>
                {t('palette.cancel')}
              </button>
              <button className="primary" onClick={() => void submitTeam()}>
                {t('palette.join')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
