import { useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { canCreate, createFromDraft, CreateBotError, previewCharacter, type Character } from '../lib/createBot.js'
import { AvatarPicker } from './AvatarPicker.js'
import { BotAvatar, useAvatarTheme } from './BotAvatar.js'

export function CreateBotDialog({ onClose, onCreated }: { onClose(): void; onCreated(bot: BotDto): void }) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null)
  const theme = useAvatarTheme()
  const [provisionalId] = useState(() => `new-${crypto.randomUUID()}`)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'' | 'createBot.failed' | 'createBot.saveFailed'>('')
  const created = useRef<BotDto | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Character | null>(null)
  const character = useMemo(() => picked ?? previewCharacter(provisionalId), [picked, provisionalId])

  useLayoutEffect(() => {
    dialog.current?.showModal()
    nameInput.current?.focus()
  }, [])

  const cancel = () => { if (!busy) onClose() }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canCreate(name) || busy) return
    setBusy(true)
    const draft = { name, label: '', templateId: '', task: '', avatar: character }
    try {
      const bot = await createFromDraft(api, draft, created.current)
      onClose()
      onCreated(bot)
      requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="bots-view"] [data-testid="bots-input"]')?.focus()))
    } catch (failure) {
      if (failure instanceof CreateBotError) created.current = failure.bot
      setError(created.current ? 'createBot.saveFailed' : 'createBot.failed')
      setBusy(false)
    }
  }

  const host = document.querySelector('[data-testid="shell"]') ?? document.body
  return createPortal(<dialog role="dialog" ref={dialog} className="create-bot-dialog" data-testid="create-bot-dialog" aria-labelledby="create-bot-title"
    onCancel={event => { event.preventDefault(); cancel() }} onKeyDown={onKeyDown}>
    <form onSubmit={event => void submit(event)}>
      <h2 id="create-bot-title">{t('createBot.title')}</h2>
      <div className="create-bot-look">
        <div className="create-bot-preview" data-testid="create-bot-preview" data-avatar={`${character.body}-${character.face}-${character.accessory}-${character.palette}`}>
          <BotAvatar id={provisionalId} override={character} size={96} state="idle" theme={theme} />
        </div>
        <button type="button" className="secondary" data-testid="create-bot-avatar-change" aria-expanded={picking} aria-controls={`avatar-picker-${provisionalId}`}
          onClick={() => setPicking(open => !open)}>{t('createBot.avatarChange')}</button>
      </div>
      {picking && <AvatarPicker id={provisionalId} primary={false} value={character} theme={theme}
        onPick={setPicked} onDefault={() => setPicked(null)} />}
      <label className="create-bot-field">
        <span>{t('createBot.name')}</span>
        <input ref={nameInput} data-testid="create-bot-name" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
      </label>
      {error && <p className="create-bot-error" role="alert">{t(error)}</p>}
      <div className="create-bot-actions">
        <button type="button" className="secondary" onClick={cancel} disabled={busy}>{t('createBot.cancel')}</button>
        <button type="submit" className="primary" data-testid="create-bot-submit" disabled={!canCreate(name) || busy}>{t('createBot.create')}</button>
      </div>
    </form>
  </dialog>, host)
}
