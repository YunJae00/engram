import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { t, type StringKey } from '../i18n.js'
import { currentCharacter, optionLabel, pickerOptions, randomCharacter, stepRadio, withPart, type Part } from '../lib/avatarPicker.js'
import { avatarSpec, paletteOf } from '../lib/botAvatar.js'
import type { Character } from '../lib/createBot.js'
import { BotAvatar } from './BotAvatar.js'

const ROWS: readonly (readonly [Part, StringKey])[] = [['body', 'avatarPicker.body'], ['face', 'avatarPicker.face'], ['accessory', 'avatarPicker.accessory'], ['palette', 'avatarPicker.palette']]
const MAX_BYTES = 5_242_880

type Props = { id: string; primary: boolean; value: unknown; theme: 'light' | 'dark'; onPick(next: Character): void; onDefault(): void; onPhoto(data: Uint8Array): void }

export function AvatarPicker({ id, primary, value, theme, onPick, onDefault, onPhoto }: Props) {
  const [tab, setTab] = useState<'character' | 'photo'>('character')
  const [invalid, setInvalid] = useState(false)
  const random = useRef(0)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
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
    generation.current++
    onPick(withPart(character, part, v))
  }
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    const mine = ++generation.current
    const data = new Uint8Array(await file.arrayBuffer())
    input.value = ''
    if (generation.current !== mine) return
    const ok = (file.type === 'image/png' || file.type === 'image/jpeg') && data.byteLength >= 1 && data.byteLength <= MAX_BYTES
    setInvalid(!ok)
    if (ok) onPhoto(data)
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
      <div role="tablist" aria-label={t('avatarPicker.title')}>
        <button type="button" role="tab" id={`${id}-picker-tab-character`} aria-selected={tab === 'character'} aria-controls={`${id}-picker-character`} onClick={() => setTab('character')}>{t('avatarPicker.character')}</button>
        <button type="button" role="tab" id={`${id}-picker-tab-photo`} aria-selected={tab === 'photo'} aria-controls={`${id}-picker-photo`} onClick={() => setTab('photo')}>{t('avatarPicker.photo')}</button>
      </div>
      {tab === 'character' ? (
        <div role="tabpanel" className="avatar-picker-panel" id={`${id}-picker-character`} aria-labelledby={`${id}-picker-tab-character`}>
          <div className="avatar-picker-preview"><BotAvatar id={id} override={value} primary={primary} size={96} state="idle" theme={theme} /></div>
          {ROWS.map(([part, label]) => row(part, label))}
          <div className="avatar-picker-actions">
            <button type="button" className="secondary" data-testid="avatar-picker-random" onClick={() => { generation.current++; onPick(randomCharacter(id, ++random.current, character.accessory)) }}>{t('avatarPicker.random')}</button>
            <button type="button" className="secondary" data-testid="avatar-picker-default" onClick={() => { generation.current++; onDefault() }}>{t('avatarPicker.default')}</button>
          </div>
        </div>
      ) : (
        <div role="tabpanel" className="avatar-picker-panel" id={`${id}-picker-photo`} aria-labelledby={`${id}-picker-tab-photo`}>
          <label className="avatar-picker-upload">
            <span>{t('avatarPicker.upload')}</span>
            <input type="file" accept="image/png,image/jpeg" data-testid="avatar-picker-file" onChange={event => void choose(event)} />
          </label>
          {invalid && <p role="alert">{t('avatarPicker.photoInvalid')}</p>}
        </div>
      )}
    </div>
  )
}
