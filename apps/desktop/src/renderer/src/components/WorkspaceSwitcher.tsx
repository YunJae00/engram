import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, User, Users } from 'lucide-react'
import type { WorkspaceInfoDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { DialogHeader } from './DialogHeader.js'

// Top-bar vault selector: swaps between registered workspaces. Switching,
// creating, or joining all relaunch the app into the chosen vault, so there is
// no post-action UI — the window is torn down by the main process.
type DialogMode = 'none' | 'new' | 'join'

type Registry = { current: string | null; vaults: WorkspaceInfoDto[] }

export function WorkspaceSwitcher() {
  // Empty registry is a valid state (e2e/onboarding run with ENGRAM_VAULT and no
  // registered workspaces) — the switcher still renders with the New/Join rows.
  const [registry, setRegistry] = useState<Registry>({ current: null, vaults: [] })
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogMode>('none')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  // Name of the workspace the app is relaunching into (switch/create/join all
  // tear the window down); non-null renders the full-screen restart notice.
  const [switching, setSwitching] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api
      .workspaceList()
      .then(setRegistry)
      .catch(() => setRegistry({ current: null, vaults: [] }))
  }, [])

  // Close the dropdown/dialog on an outside mousedown or Escape (window-level so
  // clicks anywhere on the canvas dismiss it).
  useEffect(() => {
    if (!open && dialog === 'none') return
    const onDown = (event: MouseEvent) => {
      if (open && rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setDialog('none')
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, dialog])

  const current = registry.vaults.find((v) => v.id === registry.current)
  const currentName = current?.name ?? 'Engram'

  const onSwitch = (id: string) => {
    if (id === registry.current) return
    const target = registry.vaults.find((v) => v.id === id)
    setOpen(false)
    setSwitching(target?.name ?? '')
    // Let the notice paint before the main process tears the window down, so the
    // relaunch reads as a deliberate transition instead of a crash.
    window.setTimeout(() => void api.workspaceSwitch(id), 120)
  }

  const openDialog = (mode: DialogMode) => {
    setName('')
    setUrl('')
    setBusy(false)
    setDialog(mode)
    setOpen(false)
  }

  const submit = () => {
    if (busy || !name.trim()) return
    if (dialog === 'join' && !url.trim()) return
    setBusy(true)
    // Both calls relaunch the app on success; show the restart notice while the
    // vault is prepared, and fall back to the dialog if the call fails.
    const trimmed = name.trim()
    setSwitching(trimmed)
    const call = dialog === 'join' ? api.workspaceJoin(trimmed, url.trim()) : api.workspaceCreate(trimmed)
    void call.catch(() => {
      setSwitching(null)
      setBusy(false)
    })
  }

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        className="workspace-trigger"
        data-testid="workspace-switcher"
        onClick={() => setOpen((v) => !v)}
        title={t('ws.switch')}
      >
        <span className="workspace-name">{currentName}</span>
        <ChevronDown className="workspace-chevron" size={13} strokeWidth={1.8} aria-hidden />
      </button>

      {open && (
        <div className="workspace-menu" data-testid="workspace-menu">
          {registry.vaults.map((v) => (
            <button key={v.id} className="workspace-row" onClick={() => onSwitch(v.id)}>
              {v.kind === 'team' ? (
                <Users size={13} strokeWidth={1.8} aria-hidden />
              ) : (
                <User size={13} strokeWidth={1.8} aria-hidden />
              )}
              <span className="workspace-row-name">{v.name}</span>
              {v.id === registry.current && (
                <Check className="workspace-check" size={13} strokeWidth={1.8} aria-hidden />
              )}
            </button>
          ))}
          {registry.vaults.length > 0 && <div className="workspace-divider" />}
          <button className="workspace-row" onClick={() => openDialog('new')}>
            {t('ws.new')}
          </button>
          <button className="workspace-row" onClick={() => openDialog('join')}>
            {t('ws.join')}
          </button>
          {/* GitHub backup only makes sense for a personal vault — a team vault
              already has its remote. Empty registry = the default personal vault. */}
          {current?.kind !== 'team' && (
            <>
              <div className="workspace-divider" />
              <button
                className="workspace-row"
                data-testid="workspace-github-backup"
                onClick={() => {
                  setOpen(false)
                  window.dispatchEvent(new Event('engram:open-github'))
                }}
              >
                {t('workspace.githubBackup')}
              </button>
            </>
          )}
        </div>
      )}

      {dialog !== 'none' && (
        <div className="brief-overlay" onClick={() => setDialog('none')}>
          <div className="brief-box" onClick={(e) => e.stopPropagation()}>
            <DialogHeader closeLabel={t('ws.cancel')} onClose={() => setDialog('none')}>
              {dialog === 'new' ? t('ws.newTitle') : t('ws.joinTitle')}
            </DialogHeader>
            <input
              autoFocus
              placeholder={t('ws.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {dialog === 'join' && (
              <input
                placeholder={t('ws.urlPlaceholder')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            )}
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setDialog('none')}>
                {t('ws.cancel')}
              </button>
              <button className="primary" disabled={busy} onClick={submit}>
                {dialog === 'new' ? t('ws.create') : t('ws.joinAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {switching !== null && (
        <div className="workspace-switching" data-testid="workspace-switching">
          <span className="workspace-switching-title">{t('ws.switching', { name: switching })}</span>
          <span className="workspace-switching-sub">{t('ws.switchingSub')}</span>
        </div>
      )}
    </div>
  )
}
