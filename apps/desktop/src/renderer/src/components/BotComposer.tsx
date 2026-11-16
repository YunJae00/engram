import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { t } from '../i18n.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { cometChannel } from '../lib/cometThreads.js'
import type { ChatAttachmentDto } from '../../../shared/types.js'

interface Props {
  botId: string
  initialDraft: string
  busy: boolean
  locked: boolean
  onSend(message: string, attachments: ChatAttachmentDto[]): void
  onStop(): void
}

export function BotComposer({ botId, initialDraft, busy, locked, onSend, onStop }: Props) {
  const [value, setValue] = useState(initialDraft)
  const attachments = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId).attachments)
  const valueRef = useRef(value)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const composer = rootRef.current
    const host = composer?.closest<HTMLElement>('.bots-main')
    if (!composer || !host) return
    // The compact web sheet ends above the draft and any waiting routine controls.
    const measure = () => {
      const style = getComputedStyle(composer)
      const space = composer.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
      host.style.setProperty('--composer-space', `${space}px`)
      const box = composer.querySelector('.chat-write textarea')
      if (!box) return
      const text = getComputedStyle(box)
      const oneLine = parseFloat(text.lineHeight) + parseFloat(text.paddingTop) + parseFloat(text.paddingBottom)
      composer.toggleAttribute('data-multiline', box.getBoundingClientRect().height > oneLine + 1)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(composer)
    measure()
    return () => { observer.disconnect(); host.style.removeProperty('--composer-space') }
  }, [])

  useEffect(() => {
    if (initialDraft === valueRef.current) return
    valueRef.current = initialDraft
    setValue(initialDraft)
  }, [initialDraft, busy])

  // Typing keeps the store's draft equal to the box, so any other difference
  // is the draft being taken (queued, steered) or put back.
  useEffect(() => {
    const sync = () => {
      const draft = cometThreads.thread(botId).draft
      if (draft === valueRef.current) return
      valueRef.current = draft
      setValue(draft)
    }
    const offDraft = cometThreads.subscribeDraft(sync)
    const off = cometThreads.subscribe(sync)
    return () => { offDraft(); off() }
  }, [botId])

  const putBack = useSyncExternalStore(cometThreads.subscribeDraft, () => !!cometThreads.thread(botId).restored)

  const change = (next: string) => {
    valueRef.current = next
    setValue(next)
    cometThreads.setDraft(botId, next)
  }

  const send = () => {
    const message = value.trim()
    if ((!message && !attachments.length) || locked) return
    onSend(message, attachments)
  }

  return (
    <div className="bots-write conversation-dock bots-column" ref={rootRef}>
      <ChatComposer
        testId="bots-input"
        autoFocus
        putBack={putBack}
        value={value}
        placeholder={locked ? t('errands.busy') : t('bots.placeholder')}
        maxLength={2000}
        busy={busy}
        canQueue
        disabled={locked}
        attachments={attachments}
        onAttachmentsChange={(next) => cometThreads.setAttachments(botId, next)}
        onChange={change}
        onSend={send}
        onStop={onStop}
        tools={<ModelPicker scope={cometChannel(botId)} />}
      />
    </div>
  )
}
