import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BotDto, BotTemplateDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { sendCometMessage } from '../lib/attachments.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { canCreate, clipLabel, createFromDraft, CreateBotError, previewCharacter, templatePrefill, type Character } from '../lib/createBot.js'
import { withPart } from '../lib/avatarPicker.js'
import { AvatarPicker } from './AvatarPicker.js'
import { useShellState } from '../state-slices.js'
import { BotAvatar, useAvatarTheme } from './BotAvatar.js'

export function CreateBotDialog({ onClose, onCreated }: { onClose(): void; onCreated(bot: BotDto): void }) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null)
  const { showToast } = useShellState()
  const theme = useAvatarTheme()
  const [provisionalId] = useState(() => `new-${crypto.randomUUID()}`)
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [accessory, setAccessory] = useState(0)
  const [task, setTask] = useState('')
  const [templates, setTemplates] = useState<BotTemplateDto[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'' | 'createBot.failed' | 'createBot.saveFailed'>('')
  const created = useRef<BotDto | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Character | null>(null)
  const [photo, setPhoto] = useState<{ data: Uint8Array; url: string } | null>(null)
  const character = useMemo(() => picked ?? previewCharacter(provisionalId, accessory), [picked, provisionalId, accessory])
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url) }, [photo])

  useLayoutEffect(() => {
    dialog.current?.showModal()
    nameInput.current?.focus()
  }, [])
  useEffect(() => {
    let live = true
    api.botTemplates().then(list => { if (live) setTemplates(list) }, () => undefined)
    return () => { live = false }
  }, [])

  const pickTemplate = (id: string) => {
    setTemplateId(id)
    const template = templates.find(one => one.id === id)
    if (!template) { setAccessory(0); return }
    const prefill = templatePrefill(template)
    setName(prefill.name)
    setLabel(clipLabel(prefill.label))
    setAccessory(prefill.accessory)
    setPicked(prior => prior && withPart(prior, 'accessory', prefill.accessory))
  }
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
    const draft = { name, label, templateId, task, avatar: character }
    const held = photo
    try {
      const made = await createFromDraft(api, draft, created.current)
      const bot = held ? await api.botAvatarSet(made.id, held.data).catch((failure: unknown) => { throw new CreateBotError(made, failure) }) : made
      onClose()
      onCreated(bot)
      if (draft.task.trim()) sendCometMessage(api, cometThreads, bot.id, draft.task).catch((failure: unknown) => showToast(String(failure)))
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
          <BotAvatar id={provisionalId} override={photo ? { image: 'pending' } : character} imageUrl={photo?.url} size={96} state="idle" theme={theme} />
        </div>
        <button type="button" className="secondary" data-testid="create-bot-avatar-change" aria-expanded={picking} aria-controls={`avatar-picker-${provisionalId}`}
          onClick={() => setPicking(open => !open)}>{t('createBot.avatarChange')}</button>
      </div>
      {picking && <AvatarPicker id={provisionalId} primary={false} value={character} theme={theme}
        onPick={next => { setPicked(next); setPhoto(null) }} onDefault={() => { setPicked(null); setPhoto(null) }}
        onPhoto={data => setPhoto({ data, url: URL.createObjectURL(new Blob([data as BlobPart], { type: data[0] === 0x89 ? 'image/png' : 'image/jpeg' })) })} />}
      <label className="create-bot-field">
        <span>{t('createBot.name')}</span>
        <input ref={nameInput} data-testid="create-bot-name" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
      </label>
      <label className="create-bot-field">
        <span>{t('createBot.label')}</span>
        <input data-testid="create-bot-label" value={label} onChange={event => setLabel(clipLabel(event.target.value))} />
      </label>
      <label className="create-bot-field">
        <span>{t('createBot.template')}</span>
        <select data-testid="create-bot-template" value={templateId} onChange={event => pickTemplate(event.target.value)}>
          <option value="">{t('createBot.templateNone')}</option>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      <label className="create-bot-field">
        <span>{t('createBot.task')}</span>
        <textarea data-testid="create-bot-task" rows={3} value={task} onChange={event => setTask(event.target.value)} />
      </label>
      {error && <p className="create-bot-error" role="alert">{t(error)}</p>}
      <div className="create-bot-actions">
        <button type="button" className="secondary" onClick={cancel} disabled={busy}>{t('createBot.cancel')}</button>
        <button type="submit" className="primary" data-testid="create-bot-submit" disabled={!canCreate(name) || busy}>{t('createBot.create')}</button>
      </div>
    </form>
  </dialog>, host)
}
