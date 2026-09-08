import { useEffect, useRef, useState } from 'react'
import { Orbit } from 'lucide-react'
import { t } from '../i18n.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { CometMemory } from './CometMemory.js'
import { ModelPicker } from './ModelPicker.js'
import { WebPaneButton } from './WebPaneButton.js'
import { ComputerButton } from './ComputerButton.js'
import { cometChannel } from '../lib/cometThreads.js'

interface Props {
  botId: string
  botName: string
  initialDraft: string
  busy: boolean
  locked: boolean
  memoryOpen: boolean
  onToggleMemory(): void
  onSend(message: string): void
  onStop(): void
}

export function BotComposer({ botId, botName, initialDraft, busy, locked, memoryOpen, onToggleMemory, onSend, onStop }: Props) {
  const [value, setValue] = useState(initialDraft)
  const valueRef = useRef(value)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const composer = rootRef.current
    const host = composer?.closest<HTMLElement>('.bots-main')
    if (!composer || !host) return
    // The compact web sheet ends above the actual draft, including multiline input.
    const measure = () => {
      const style = getComputedStyle(composer)
      const space = composer.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
      host.style.setProperty('--composer-space', `${space}px`)
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
  }, [initialDraft])

  useEffect(() => {
    if (!memoryOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onToggleMemory()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggleMemory()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [memoryOpen, onToggleMemory])

  const change = (next: string) => {
    valueRef.current = next
    setValue(next)
    cometThreads.setDraft(botId, next)
  }

  const send = () => {
    const message = value.trim()
    if (!message || busy || locked) return
    valueRef.current = ''
    setValue('')
    cometThreads.setDraft(botId, '')
    onSend(message)
  }

  return (
    <div className="bots-write conversation-dock" ref={rootRef}>
      {memoryOpen && <CometMemory botId={botId} name={botName} />}
      <ChatComposer
        testId="bots-input"
        autoFocus
        value={value}
        placeholder={locked ? t('errands.busy') : t('bots.placeholder')}
        maxLength={2000}
        busy={busy}
        disabled={locked}
        onChange={change}
        onSend={send}
        onStop={onStop}
        tools={
          <>
            <button
              className={`composer-cosmos${memoryOpen ? ' armed' : ''}`}
              data-testid="bots-memory-toggle"
              title={t('bots.memory')}
              aria-label={t('bots.memory')}
              onClick={onToggleMemory}
            >
              <Orbit size={14} strokeWidth={1.8} aria-hidden />
              <span>{t('topbar.tabSky')}</span>
            </button>
            <WebPaneButton busy={busy} lane={cometChannel(botId)} />
            <ComputerButton lane={cometChannel(botId)} />
            <ModelPicker />
          </>
        }
      />
    </div>
  )
}
