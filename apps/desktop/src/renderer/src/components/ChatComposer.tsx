import { ArrowUp, Square } from 'lucide-react'
import { forwardRef, memo, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { t } from '../i18n.js'
import { useAutoGrow } from '../lib/useAutoGrow.js'

interface Props {
  value: string
  placeholder: string
  maxLength: number
  busy: boolean
  disabled?: boolean
  testId?: string
  autoFocus?: boolean
  tools?: ReactNode
  onChange(value: string): void
  onSend(): void
  onStop(): void
}

export const ChatComposer = memo(
  forwardRef<HTMLTextAreaElement, Props>(function ChatComposer(
    { value, placeholder, maxLength, busy, disabled = false, testId, autoFocus = false, tools, onChange, onSend, onStop },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => inputRef.current!)
    useAutoGrow(inputRef, value)

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      onSend()
    }

    return (
      <div className="chat-write">
        <textarea
          ref={inputRef}
          data-testid={testId}
          autoFocus={autoFocus}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-write-footer">
          <div className="chat-write-tools">{tools}</div>
          {busy ? (
            <button className="chat-send-btn armed bubble-stop" aria-label={t('bubble.stop')} onClick={onStop}>
              <Square size={11} strokeWidth={2.5} aria-hidden />
            </button>
          ) : (
            <button
              className="chat-send-btn armed"
              data-testid={testId ? `${testId}-send` : undefined}
              aria-label={t('chat.send')}
              disabled={disabled || !value.trim()}
              onClick={onSend}
            >
              <ArrowUp size={16} strokeWidth={2.2} aria-hidden />
            </button>
          )}
        </div>
      </div>
    )
  }),
)
