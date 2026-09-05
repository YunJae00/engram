import { useEffect, useState } from 'react'
import { CheckCircle2, RefreshCw, UploadCloud } from 'lucide-react'
import type { SyncStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DialogHeader } from './DialogHeader.js'

// One-click GitHub backup (browser-assisted, no OAuth app). Two steps in one
// modal: (1) open GitHub's prefilled create-repo page, (2) paste the repo URL
// and connect. The bundled git's credential manager handles auth on first push.
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `engram-${slug}` : 'engram-vault'
}

export function GithubConnect({ onClose }: { onClose(): void }) {
  const { showToast, refresh, t } = useApp()
  const [suggested, setSuggested] = useState('engram-vault')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null)
  const [sync, setSync] = useState<SyncStatusDto | null>(null)
  const [auto, setAuto] = useState(true)
  const connected = !!sync?.remote

  useEscape(onClose, !busy)

  useEffect(() => {
    void api.syncStatus().then(setSync).catch(() => setSync(null))
    void api.settingsGet().then((s) => setAuto(s.teamSync === 'auto')).catch(() => {})
  }, [])

  const setAutoSync = async (next: boolean) => {
    setAuto(next)
    const current = await api.settingsGet()
    await api.settingsSet({ ...current, teamSync: next ? 'auto' : 'manual' })
  }

  const syncNow = async () => {
    setBusy(true)
    try {
      setSync(await api.syncNow())
      showToast(t('github.synced'))
    } catch (err) {
      setError({ text: `${t('github.failed')} — ${err instanceof Error ? err.message : String(err)}`, retry: true })
    }
    setBusy(false)
  }

  // Derive a friendly default repo name from the current workspace ("Engram"
  // → "engram-personal"). Empty registry (onboarding/e2e) falls back sensibly.
  useEffect(() => {
    void api
      .workspaceList()
      .then((reg) => {
        const current = reg.vaults.find((v) => v.id === reg.current)
        setSuggested(slugify(current?.name ?? ''))
      })
      .catch(() => setSuggested('engram-vault'))
  }, [])

  const openRepo = () => void api.githubOpenNew(suggested)

  const connect = async () => {
    if (busy || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.githubConnect(url.trim())
      if (result.ok) {
        showToast(t('github.backedUp'))
        await refresh()
        onClose()
        return
      }
      setError({ text: result.detail ? `${t('github.failed')} — ${result.detail}` : t('github.failed'), retry: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('already-connected')) setError({ text: t('github.alreadyConnected'), retry: false })
      else setError({ text: `${t('github.failed')} — ${message.replace(/^.*Error: /, '')}`, retry: true })
    }
    setBusy(false)
  }

  return (
    <div className="brief-overlay" onClick={() => !busy && onClose()}>
      <div className="brief-box github-connect" onClick={(e) => e.stopPropagation()} data-testid="github-connect">
        <DialogHeader
          closeLabel={connected ? t('github.done') : t('github.cancel')}
          icon={<UploadCloud size={16} strokeWidth={1.8} aria-hidden />}
          disabled={busy}
          onClose={onClose}
        >
          {t('github.title')}
        </DialogHeader>
        {connected ? (
          <div className="github-connected" data-testid="github-connected">
            <div className="github-connected-head">
              <CheckCircle2 size={15} strokeWidth={1.9} aria-hidden />
              <span>{t('github.connectedTo')}</span>
            </div>
            <code className="github-remote">{sync!.remote}</code>
            <div className="setting-hint" data-testid="github-sync-state">
              {sync!.state === 'clean'
                ? t('github.upToDate')
                : sync!.state === 'error'
                  ? t('github.stateError')
                  : t('github.pending', { ahead: sync!.ahead, behind: sync!.behind })}
            </div>
            <label className="setting-row">
              <span>{t('github.autoSync')}</span>
              <input
                type="checkbox"
                className="switch"
                data-testid="github-auto-sync"
                checked={auto}
                onChange={(e) => void setAutoSync(e.target.checked)}
              />
            </label>
            <div className="setting-hint">{t('github.autoSyncHint')}</div>
          </div>
        ) : (
          <p className="github-intro">{t('github.intro')}</p>
        )}

        {!connected && (
          <>
            <div className="github-step">
              <span className="github-step-num">1</span>
              <div className="github-step-body">
                <button className="secondary" data-testid="github-open-repo" onClick={openRepo} disabled={busy}>
                  {t('github.openRepo')}
                </button>
                <div className="setting-hint">{t('github.openHint')}</div>
              </div>
            </div>

            <div className="github-step">
              <span className="github-step-num">2</span>
              <div className="github-step-body">
                <label className="github-url-label">{t('github.urlLabel')}</label>
                <input
                  autoFocus
                  data-testid="github-url"
                  placeholder={t('github.urlPlaceholder')}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void connect()}
                  disabled={busy}
                />
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="github-error" data-testid="github-error">
            <div>{error.text}</div>
            {error.retry && <div className="setting-hint">{t('github.retry')}</div>}
          </div>
        )}

        <div className="dialog-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            {connected ? t('github.done') : t('github.cancel')}
          </button>
          {connected ? (
            <button className="primary" data-testid="github-sync-now" onClick={() => void syncNow()} disabled={busy}>
              <RefreshCw size={13} strokeWidth={1.9} aria-hidden /> {busy ? t('github.syncing') : t('github.syncNow')}
            </button>
          ) : (
            <button className="primary" data-testid="github-connect-btn" onClick={() => void connect()} disabled={busy || !url.trim()}>
              {busy ? t('github.connecting') : t('github.connect')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
