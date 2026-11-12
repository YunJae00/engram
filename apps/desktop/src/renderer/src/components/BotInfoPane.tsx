import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, type StringKey } from '../i18n.js'
import { INSTRUCTIONS_MAX, capInstructions, instructionsSaver } from '../lib/botInfo.js'
import { useApp } from '../state.js'
import { useShellState } from '../state-slices.js'
import { BotAvatar } from './BotAvatar.js'
import { AvatarPicker } from './AvatarPicker.js'
import { avatarSaver, type AvatarChange } from '../lib/avatarPicker.js'
import { forgetBotImage } from '../lib/botImage.js'
import { CometMemory } from './CometMemory.js'
import { ChatAttachment } from './ChatAttachment.js'
import { AnswerFiles } from './AnswerFiles.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { botFiles } from '../lib/botFiles.js'
import { BotRoutinesTab } from './BotRoutinesTab.js'
import { BotPastTab } from './BotPastTab.js'
import { BotComputerTab } from './BotComputerTab.js'

const TABS = [['overview', 'botInfo.overview'], ['routines', 'botInfo.routines'], ['files', 'botInfo.files'], ['computer', 'botInfo.computer'], ['past', 'botInfo.past']] as const
type TabKey = typeof TABS[number][0]
const NOTIFY: [NonNullable<BotDto['notify']>, StringKey][] = [['all', 'botInfo.notifyAll'], ['attention', 'botInfo.notifyAttention'], ['off', 'botInfo.notifyOff']]

function FilesTab({ botId, empty }: { botId: string; empty: ReactNode }) {
  const messages = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId).messages)
  const files = useMemo(() => botFiles(messages), [messages])
  if (!files.length) return empty
  return <div data-testid="bot-files">{files.map(file => file.kind === 'attachment'
    ? <ChatAttachment key={`a:${file.id}`} id={file.id} />
    : <AnswerFiles key={`f:${file.id}`} files={[{ id: file.id, name: file.name }]} />)}</div>
}

export function BotInfoPane({ bot, entering, closing, onClose, onClosed, onEntered }: { bot: BotDto; entering: boolean; closing: boolean; onClose: () => void; onClosed: () => void; onEntered: () => void }) {
  const { theme } = useApp()
  const { showToast, openNote } = useShellState()
  const [tab, setTab] = useState<TabKey>('overview')
  const [mounted, setMounted] = useState<Set<TabKey>>(() => new Set(['overview']))
  const [text, setText] = useState(() => bot.purpose ?? '')
  const toast = useRef(showToast)
  toast.current = showToast
  const saver = useRef<ReturnType<typeof instructionsSaver> | null>(null)
  saver.current ??= instructionsSaver((id, purpose) => api.botUpdate(id, { purpose }), (error) => toast.current(String(error)))

  const [picking, setPicking] = useState(false)
  const [local, setLocal] = useState<{ avatar: unknown } | null>(null)
  const avatarWrites = useRef<ReturnType<typeof avatarSaver> | null>(null)
  avatarWrites.current ??= avatarSaver(bot.id, {
    update: avatar => api.botUpdate(bot.id, { avatar }), set: data => api.botAvatarSet(bot.id, data), clear: () => api.botAvatarClear(bot.id),
  }, (error) => {
    forgetBotImage(bot.id)
    if (error !== undefined) toast.current(String(error))
    if (avatarWrites.current?.idle()) setLocal(error === undefined ? { avatar: avatarWrites.current.latest() } : null)
  })
  useEffect(() => { if (avatarWrites.current?.idle()) setLocal(null) }, [bot.avatar])
  const saveAvatar = (change: AvatarChange, shown: unknown) => { setLocal({ avatar: shown }); avatarWrites.current?.save(change, bot.avatar) }

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
  const select = (key: TabKey) => {
    setTab(key)
    setMounted((prior) => (prior.has(key) ? prior : new Set(prior).add(key)))
  }
  const setNotify = (notify: NonNullable<BotDto['notify']>) => {
    void api.botUpdate(bot.id, { notify }).catch((error: unknown) => showToast(String(error)))
  }

  return (
    <aside className={`bot-info-pane${entering ? ' entering' : ''}${closing ? ' closing' : ''}`} id="bot-info-pane" data-testid="bot-info-pane" aria-label={t('botInfo.pane')} onKeyDown={onKeyDown}
      onAnimationEnd={(event) => { if (event.target !== event.currentTarget) return; if (closing) onClosed(); else onEntered() }}>
      <div role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" id={`bot-info-tab-${key}`} aria-selected={tab === key} aria-controls={`bot-info-panel-${key}`} onClick={() => select(key)}>{t(label)}</button>
        ))}
      </div>
      {TABS.filter(([key]) => mounted.has(key)).map(([key]) => (
        <div key={key} role="tabpanel" id={`bot-info-panel-${key}`} aria-labelledby={`bot-info-tab-${key}`} className={`bot-info-panel bot-info-${key}`} hidden={tab !== key}>
          {key === 'overview' ? (
            <>
              <button type="button" className="bot-info-avatar" data-testid="bot-info-avatar" aria-label={t('avatarPicker.open')} aria-expanded={picking} aria-controls="bot-info-avatar-picker" onClick={() => setPicking(open => !open)}>
              <BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={96} state="idle" theme={theme} />
              </button>
              {picking && <div id="bot-info-avatar-picker"><AvatarPicker id={bot.id} primary={bot.primary === true} value={local ? local.avatar : bot.avatar} theme={theme}
                onPick={next => saveAvatar({ kind: 'pick', next }, next)} onDefault={() => saveAvatar({ kind: 'default' }, undefined)} /></div>}
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
            </>
          ) : ((empty) => key === 'files' ? <FilesTab botId={bot.id} empty={empty} /> : key === 'routines' ? <BotRoutinesTab bot={bot} empty={empty} /> : key === 'past' ? <BotPastTab bot={bot} active={tab === 'past'} empty={empty} /> : key === 'computer' ? <BotComputerTab bot={bot} empty={empty} /> : empty)(
            <div data-testid="bot-info-empty">
              <p>{t('botInfo.emptySoon')}</p>
              <button type="button" className="secondary" onClick={close}>{t('topbar.close')}</button>
            </div>
          )}
        </div>
      ))}
    </aside>
  )
}
