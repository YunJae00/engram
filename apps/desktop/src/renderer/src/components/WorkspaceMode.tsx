import { Code2 } from 'lucide-react'
import { Comet } from './Icon.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

export function WorkspaceMode({ developer, onChange }: { developer: boolean; onChange(mode: 'bots' | 'developers'): void }) {
  if (!api.developerUiEnabled) return null
  return <div className="workspace-mode-toggle" role="group" aria-label={t('sidebar.workspaceMode')}>
    <button data-testid="mode-bots" aria-label={t('sidebar.cometsMode')} title={t('topbar.tabBots')} aria-pressed={!developer} onClick={() => onChange('bots')}><Comet size={16} /></button>
    {api.developerUiEnabled && <button data-testid="activity-developers" aria-label={t('sidebar.developersMode')} title={t('sidebar.developers')} aria-pressed={developer} onClick={() => onChange('developers')}><Code2 size={16} aria-hidden /></button>}
  </div>
}
