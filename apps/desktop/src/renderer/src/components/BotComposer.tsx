import { useEffect, useRef, useState } from 'react'
import { Orbit } from 'lucide-react'
import { t } from '../i18n.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { WebPaneButton } from './WebPaneButton.js'

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

  useEffect(() => {
    if (initialDraft === valueRef.current) return
    valueRef.current = initialDraft
    setValue(initialDraft)
  }, [initialDraft])

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
    <div className="bots-write">
      <ChatComposer
        testId="bots-input"
        autoFocus
        value={value}
        placeholder={locked ? t('errands.busy') : t('bots.placeholder', { name: botName })}
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
            <WebPaneButton busy={busy} />
            <ModelPicker />
          </>
        }
      />
    </div>
  )
}
