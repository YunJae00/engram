import { ArrowUp } from 'lucide-react'
import { marked } from 'marked'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { Logomark } from '../components/Icon.js'
import { t } from '../i18n.js'
import type { ChatTurnDto } from '../../../shared/types.js'

interface Message extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
}

// Newest streaming assistant bubble (mirrors ChatPanel's streamingIndex —
// tokens must land in the message they belong to, not blindly in the last).
function streamingAt(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'assistant' && m.streaming) return i
  }
  return -1
}

const Bubble = memo(function Bubble({ text, onOpenNote }: { text: string; onOpenNote: (id: string) => void }) {
  // Mid-stream, a capture marker tail may arrive before main strips it from
  // the final text — never show the plumbing.
  const visible = text.split('<engram:capture')[0] ?? ''
  const html = useMemo(() => marked.parse(visible || '…', { async: false }) as string, [visible])
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('note://')) onOpenNote(href.slice('note://'.length))
  }
  return <div className="bubble-msg-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

function Thinking() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((n) => n + 1), 1_000)
    return () => clearInterval(timer)
  }, [])
  // The first answer after a cold start waits on the model itself; say so
  // rather than letting the silence look like a hang.
  const key = seconds < 8 ? 'bubble.thinking' : seconds < 30 ? 'bubble.thinkingLong' : 'bubble.thinkingCold'
  return (
    <span className="bubble-thinking" data-testid="bubble-thinking">
      <span className="bubble-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {t(key)} · {seconds}s
    </span>
  )
}

export function BubbleView() {
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmQuit, setConfirmQuit] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Transparent window: only what this view draws exists on screen.
  useEffect(() => {
    document.body.classList.add('bubble-host')
    return () => document.body.classList.remove('bubble-host')
  }, [])

  useEffect(() => {
    return api.onEvent((event) => {
      // Every window hears every broadcast — only the bubble's own stream.
      if (event.type === 'chat:token' && event.channel === 'bubble') {
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: next[at]!.text + event.text }
          return next
        })
      } else if (event.type === 'chat:done' && event.channel === 'bubble') {
        setBusy(false)
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false }
          return next
        })
      } else if (event.type === 'chat:error' && event.channel === 'bubble') {
        setBusy(false)
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
          { role: 'assistant', text: event.message, error: true },
        ])
      }
    })
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // Esc: first backs out of the quit confirm, otherwise folds the chat.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmQuit) setConfirmQuit(false)
      else void collapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, confirmQuit])

  const expand = async () => {
    await api.bubbleExpand()
    setExpanded(true)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  const gesture = useRef<{ x: number; y: number; travel: number } | null>(null)
  const onDotDown = (e: React.PointerEvent) => {
    gesture.current = { x: e.screenX, y: e.screenY, travel: 0 }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onDotMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || e.buttons === 0) return
    const dx = e.screenX - g.x
    const dy = e.screenY - g.y
    g.x = e.screenX
    g.y = e.screenY
    g.travel += Math.abs(dx) + Math.abs(dy)
    if (dx !== 0 || dy !== 0) api.bubbleDragBy(dx, dy)
  }
  const onDotUp = () => {
    const clicked = (gesture.current?.travel ?? 0) < 6
    gesture.current = null
    if (clicked) void expand()
  }

  const collapse = async () => {
    setExpanded(false)
    setConfirmQuit(false)
    await api.bubbleCollapse()
  }

  const openNote = (id: string) => void api.bubbleOpenNote(id)

  const send = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    const message = text.trim()
    if (!message || busy) return
    setText('')
    setBusy(true)
    const history = messages.filter((m) => !m.streaming && !m.error)
    setMessages((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true }])
    // engineId '' → the main process falls back to the first connected engine.
    await api.chatSend({ engineId: '', message, history, channel: 'bubble' })
  }

  if (!expanded) {
    return (
      <div
        className="bubble-dot"
        data-testid="bubble-dot"
        role="button"
        aria-label={t('bubble.open')}
        onPointerDown={onDotDown}
        onPointerMove={onDotMove}
        onPointerUp={onDotUp}
      >
        <Logomark size={30} />
      </div>
    )
  }

  return (
    <div className="bubble-chat" data-testid="bubble-chat">
      <div className="bubble-bar">
        <span className="bubble-brand"><Logomark size={13} /> Engram</span>
        <span className="bubble-bar-btns">
          <button className="bubble-x" aria-label={t('bubble.min')} onClick={() => void collapse()}>
            –
          </button>
          <button className="bubble-x" aria-label={t('bubble.quit')} onClick={() => setConfirmQuit(true)}>
            ✕
          </button>
        </span>
      </div>
      {confirmQuit && (
        <div className="bubble-confirm">
          <div className="bubble-confirm-q">{t('bubble.quitAsk')}</div>
          <div className="bubble-confirm-why">{t('bubble.quitWhy')}</div>
          <div className="bubble-confirm-actions">
            <button className="bubble-confirm-yes" onClick={() => void api.bubbleQuit()}>
              {t('bubble.quitYes')}
            </button>
            <button onClick={() => setConfirmQuit(false)}>{t('bubble.quitNo')}</button>
          </div>
        </div>
      )}
      <div className="bubble-list" ref={listRef}>
        {messages.length === 0 && <div className="bubble-hint">{t('bubble.hint')}</div>}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? (
              m.streaming && !m.text ? <Thinking /> : <Bubble text={m.text} onOpenNote={openNote} />
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>
      <form className="bubble-write" onSubmit={send}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('bubble.placeholder')}
          maxLength={2000}
        />
        <button type="submit" className="chat-send-btn armed bubble-send" aria-label={t('bubble.send')} disabled={busy || !text.trim()}>
          <ArrowUp size={15} />
        </button>
      </form>
    </div>
  )
}
