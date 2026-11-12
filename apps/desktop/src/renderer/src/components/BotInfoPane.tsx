import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, type StringKey } from '../i18n.js'
import { INSTRUCTIONS_MAX, capInstructions, instructionsSaver } from '../lib/botInfo.js'
import { useApp } from '../state.js'
import { useShellState } from '../state-slices.js'
import { BotAvatar } from './BotAvatar.js'
import { AvatarPicker } from './AvatarPicker.js'
import { avatarSaver, changedAvatar, type AvatarChange } from '../lib/avatarPicker.js'
import { CometMemory } from './CometMemory.js'
import { BotRoutinesTab } from './BotRoutinesTab.js'

const NOTIFY: [NonNullable<BotDto['notify']>, StringKey][] = [['all', 'botInfo.notifyAll'], ['attention', 'botInfo.notifyAttention'], ['off', 'botInfo.notifyOff']]

export function BotInfoPane({ bot, entering, closing, onClose, onClosed, onEntered }: { bot: BotDto; entering: boolean; closing: boolean; onClose: () => void; onClosed: () => void; onEntered: () => void }) {
  const { theme } = useApp()
  const { showToast, openNote } = useShellState()
  const [text, setText] = useState(() => bot.purpose ?? '')
  const toast = useRef(showToast)
  toast.current = showToast
  const saver = useRef<ReturnType<typeof instructionsSaver> | null>(null)
  saver.current ??= instructionsSaver((id, purpose) => api.botUpdate(id, { purpose }), (error) => toast.current(String(error)))

  const [picking, setPicking] = useState(false)
  const [local, setLocal] = useState<{ avatar: unknown } | null>(null)
  const avatarWrites = useRef<ReturnType<typeof avatarSaver> | null>(null)
  if (avatarWrites.current?.id !== bot.id) {
    avatarWrites.current?.stop()
    const writes = avatarSaver(bot.id, { update: avatar => api.botUpdate(bot.id, { avatar }) }, (error) => {
      if (error !== undefined) toast.current(String(error))
      if (writes.idle()) setLocal(error === undefined ? { avatar: writes.latest() } : null)
    })
    avatarWrites.current = writes
  }
  useEffect(() => { if (avatarWrites.current?.idle()) setLocal(null) }, [bot.avatar, bot.id])
  const saveAvatar = (change: AvatarChange) => { setLocal({ avatar: changedAvatar(bot.id, change) }); avatarWrites.current?.save(change, bot.avatar) }

  useEffect(() => () => saver.current?.flush(), [])
  useLayoutEffect(() => { if (closing) saver.current?.flush() }, [closing])

  const close = () => {
    saver.current?.flush()
    onClose()
    document.querySelector<HTMLElement>('[data-testid="bots-view"] [data-testid="bots-input"]')?.focus()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
  }
  const setNotify = (notify: NonNullable<BotDto['notify']>) => {
    void api.botUpdate(bot.id, { notify }).catch((error: unknown) => showToast(String(error)))
  }

  return (
    <aside className={`bot-info-pane${entering ? ' entering' : ''}${closing ? ' closing' : ''}`} id="bot-info-pane" data-testid="bot-info-pane" aria-label={t('botInfo.pane')} onKeyDown={onKeyDown}
      onAnimationEnd={(event) => { if (event.target !== event.currentTarget) return; if (closing) onClosed(); else onEntered() }}>
      <div className="bot-info-panel">
        <button type="button" className="bot-info-avatar" data-testid="bot-info-avatar" aria-label={t('avatarPicker.open')} aria-expanded={picking} aria-controls="bot-info-avatar-picker" onClick={() => setPicking(open => !open)}>
          <BotAvatar id={bot.id} override={local ? local.avatar : bot.avatar} primary={bot.primary === true} size={48} state="idle" theme={theme} />
        </button>
        {picking && <div id="bot-info-avatar-picker"><AvatarPicker id={bot.id} value={local ? local.avatar : bot.avatar} theme={theme}
          onPick={next => saveAvatar({ kind: 'pick', next })} onDefault={() => saveAvatar({ kind: 'default' })} /></div>}
        <h2>{bot.name}</h2>
        {bot.label && <p>{bot.label}</p>}
        <label>
          <span>{t('botInfo.instructions')}</span>
          <textarea value={text} maxLength={INSTRUCTIONS_MAX} rows={5}
            onChange={(event) => { const value = capInstructions(event.target.value); setText(value); saver.current?.edit(bot.id, value) }}
            onBlur={() => saver.current?.flush()} />
        </label>
        <CometMemory botId={bot.id} name={bot.name} />
        <button type="button" className="secondary" onClick={() => openNote('n-person-profile')}>{t('botInfo.sharedMemory')}</button>
        <div role="radiogroup" aria-label={t('botInfo.notify')}>
          <span>{t('botInfo.notify')}</span>
          {NOTIFY.map(([value, label]) => (
            <label key={value}>
              <input type="radio" name={`bot-notify-${bot.id}`} value={value} checked={(bot.notify ?? 'all') === value} onChange={() => setNotify(value)} />
              {t(label)}
            </label>
          ))}
        </div>
        <BotRoutinesTab bot={bot} empty={null} />
      </div>
    </aside>
  )
}
