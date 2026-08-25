import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import type { BotDto, BotSuggestionDto } from '../../../shared/types.js'
import { useApp } from '../state.js'
import { BotSuggestions } from './BotSuggestions.js'
import { Comet } from './Icon.js'

interface Props {
  bots: BotDto[]
  suggestions: BotSuggestionDto[]
  selectedId: string | null
  open: boolean
  onToggle(): void
  onSelect(id: string): void
  // Resolves true once the comet exists; the form only clears then.
  onCreate(name: string, purpose: string): Promise<boolean>
  onDismiss(name: string): void
}

// One rail in both states: it narrows instead of being swapped out, and the
// toggle keeps its corner - only the icon turns around. Folded, the list and
// the plus narrow into a column of chips; the form and the offers fade out.

// A column of identical icons says nothing about which comet is which; the
// chip shows the first letter instead.
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase()
}

export function CometRail({ bots, suggestions, selectedId, open, onToggle, onSelect, onCreate, onDismiss }: Props) {
  const { t } = useApp()
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPurpose, setDraftPurpose] = useState('')

  const create = async (name: string, purpose: string) => {
    if (!(await onCreate(name, purpose))) return
    setCreating(false)
    setDraftName('')
    setDraftPurpose('')
  }

  // The form needs the open rail; from the strip the plus opens it first.
  const startCreating = () => {
    if (!open) onToggle()
    setCreating(true)
  }

  return (
    <aside className={`bots-rail${open ? '' : ' folded'}`} data-testid={open ? 'bots-rail' : 'comets-rail-folded'}>
      <div className="bots-rail-head">
        {open && <span>{t('bots.railTitle')}</span>}
        <button
          className="rail-toggle"
          data-testid={open ? 'comets-rail-close' : 'comets-rail-open'}
          title={open ? t('rail.hide') : t('rail.show')}
          onClick={onToggle}
        >
          {open ? (
            <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden />
          ) : (
            <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden />
          )}
        </button>
      </div>
      <ul className="bots-list">
        {bots.map((bot) => (
          <li key={bot.id}>
            <button
              className={`bots-row${bot.id === selectedId ? ' active' : ''}`}
              data-testid={`bot-${bot.id}`}
              title={open ? undefined : bot.name}
              onClick={() => onSelect(bot.id)}
            >
              <span className="bots-row-mark" aria-hidden>
                <Comet size={14} />
                <span className="bots-row-initial">{initialOf(bot.name)}</span>
              </span>
              <span className="bots-row-name">{bot.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {creating && (
        <div className="bots-create" data-testid="bots-create">
          <input
            autoFocus
            data-testid="bots-name"
            placeholder={t('bots.nameLabel')}
            value={draftName}
            maxLength={60}
            onChange={(e) => setDraftName(e.target.value)}
          />
          <textarea
            data-testid="bots-purpose"
            placeholder={t('bots.purposeLabel')}
            value={draftPurpose}
            maxLength={500}
            rows={3}
            onChange={(e) => setDraftPurpose(e.target.value)}
          />
          {(!draftName.trim() || !draftPurpose.trim()) && (
            // A disabled button with no reason reads as a broken button —
            // this says which of the two fields is still empty.
            <div className="bots-create-need">{t(!draftName.trim() ? 'bots.needName' : 'bots.needPurpose')}</div>
          )}
          <div className="bots-create-actions">
            <button
              className="primary"
              data-testid="bots-create-submit"
              disabled={!draftName.trim() || !draftPurpose.trim()}
              onClick={() => void create(draftName, draftPurpose)}
            >
              {t('bots.create')}
            </button>
            <button className="secondary" onClick={() => setCreating(false)}>
              {t('palette.cancel')}
            </button>
          </div>
        </div>
      )}
      {(!creating || !open) && (
        <button className="bots-new" data-testid="bots-new" title={open ? undefined : t('bots.new')} onClick={startCreating}>
          <Plus size={13} strokeWidth={2} aria-hidden />
          <span className="bots-new-label">{t('bots.new')}</span>
        </button>
      )}
      <BotSuggestions
        suggestions={suggestions}
        onCreate={(name, purpose) => void create(name, purpose)}
        onDismiss={onDismiss}
      />
    </aside>
  )
}
