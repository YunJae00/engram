import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
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

  // One press, one comet: it takes its name from the first message. From the
  // strip the press also opens the rail so the new one can be seen.
  const create = async (name: string, purpose: string) => {
    if (!open) onToggle()
    await onCreate(name, purpose)
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
      <button className="bots-new" data-testid="bots-new" title={open ? undefined : t('bots.new')} onClick={() => void create(t('bots.untitled'), '')}>
        <Plus size={13} strokeWidth={2} aria-hidden />
        <span className="bots-new-label">{t('bots.new')}</span>
      </button>
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
      <BotSuggestions
        suggestions={suggestions}
        onCreate={(name, purpose) => void create(name, purpose)}
        onDismiss={onDismiss}
      />
    </aside>
  )
}
