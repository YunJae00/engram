import { useRef, type KeyboardEvent } from 'react'
import { t, type StringKey } from '../i18n.js'
import { currentCharacter, optionLabel, pickerOptions, randomCharacter, stepRadio, withPart, type Part } from '../lib/avatarPicker.js'
import { avatarSpec, paletteOf } from '../lib/botAvatar.js'
import type { Character } from '../lib/createBot.js'
import { BotAvatar } from './BotAvatar.js'

const ROWS: readonly (readonly [Part, StringKey])[] = [['body', 'avatarPicker.body'], ['face', 'avatarPicker.face'], ['accessory', 'avatarPicker.accessory'], ['palette', 'avatarPicker.palette']]

type Props = { id: string; primary: boolean; value: unknown; theme: 'light' | 'dark'; onPick(next: Character): void; onDefault(): void }

export function AvatarPicker({ id, primary, value, theme, onPick, onDefault }: Props) {
  const random = useRef(0)
  const character = currentCharacter(id, value)
  const spec = avatarSpec(id, value, primary)
  const options = pickerOptions(primary)

  const checked = (part: Part, v: number | 'sun') => {
    if (spec.kind !== 'drawn') return false
    if (part === 'body') return spec.body === v
    if (part === 'palette') return spec.palette === v
    return character[part] === v
  }
  const pick = (part: Part, v: number | 'sun') => {
    if (v === 'sun') return
    onPick(withPart(character, part, v))
  }
  const row = (part: Part, label: StringKey) => {
    const values: readonly (number | 'sun')[] = options[part]
    const anyChecked = values.some(v => checked(part, v))
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      const cells = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
      const next = stepRadio(Math.max(cells.indexOf(event.target as HTMLElement), 0), values.length, event.key)
      if (next === null) return
      event.preventDefault()
      cells[next]?.focus()
      pick(part, values[next]!)
    }
    return (
      <div key={part} role="radiogroup" className="avatar-picker-row" data-part={part} aria-label={t(label)} onKeyDown={onKeyDown}>
        {values.map((v, i) => {
          const on = checked(part, v)
          return (
            <button key={String(v)} type="button" role="radio" className="avatar-picker-cell" aria-checked={on} aria-label={t(optionLabel(part, v))}
              tabIndex={on || (!anyChecked && i === 0) ? 0 : -1} onClick={() => pick(part, v)}>
              {part === 'palette' && typeof v === 'number'
                ? <span className="avatar-picker-swatch" style={{ background: paletteOf(v)[theme].fill }} />
                : <BotAvatar id={id} override={v === 'sun' ? character : withPart(character, part, v)} primary={primary} size={36} state="idle" theme={theme} />}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="avatar-picker" data-testid="avatar-picker" id={`avatar-picker-${id}`}>
      {ROWS.map(([part, label]) => row(part, label))}
      <div className="avatar-picker-actions">
        <button type="button" className="secondary" data-testid="avatar-picker-random" onClick={() => onPick(randomCharacter(id, ++random.current, character.accessory))}>{t('avatarPicker.random')}</button>
        <button type="button" className="secondary" data-testid="avatar-picker-default" onClick={onDefault}>{t('avatarPicker.default')}</button>
      </div>
    </div>
  )
}
