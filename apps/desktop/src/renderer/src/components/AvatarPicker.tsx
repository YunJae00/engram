import type { KeyboardEvent } from 'react'
import { t } from '../i18n.js'
import { pickerOptions, stepGrid } from '../lib/avatarPicker.js'
import { avatarCharacter, type CharacterId } from '../lib/botAvatar.js'
import { BotAvatar } from './BotAvatar.js'

type Props = { id: string; value: unknown; picked?: boolean; theme: 'light' | 'dark'; onPick(next: CharacterId): void; onDefault(): void }

// picked=false shows the face without marking it chosen, as in a dialog before the person picks.
export function AvatarPicker({ id, value, picked = true, theme, onPick, onDefault }: Props) {
  const options = pickerOptions()
  const current = avatarCharacter(id, value)
  const focusIndex = Math.max(options.indexOf(current), 0)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cells = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
    const next = stepGrid(Math.max(cells.indexOf(event.target as HTMLElement), 0), options.length, event.key)
    if (next === null) return
    event.preventDefault()
    cells[next]?.focus()
    onPick(options[next]!)
  }
  return (
    <div className="avatar-picker" data-testid="avatar-picker" id={`avatar-picker-${id}`}>
      <div role="radiogroup" className="avatar-picker-grid" aria-label={t('avatarPicker.open')} onKeyDown={onKeyDown}>
        {options.map((character, i) => (
          <button key={character} type="button" role="radio" className="avatar-picker-cell" data-character={character} aria-label={character}
            aria-checked={picked && character === current} tabIndex={i === focusIndex ? 0 : -1} onClick={() => onPick(character)}>
            <BotAvatar id={id} override={{ character }} size={36} state="idle" theme={theme} />
          </button>
        ))}
      </div>
      <div className="avatar-picker-actions">
        <button type="button" className="secondary" data-testid="avatar-picker-default" onClick={onDefault}>{t('avatarPicker.default')}</button>
      </div>
    </div>
  )
}
