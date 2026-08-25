import { ArrowUp, Download, RotateCcw, Square } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { answerHtml } from '../markdown.js'
import { Logomark } from '../components/Icon.js'
import { Thinking } from '../components/Thinking.js'
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
  const html = useMemo(() => answerHtml(text), [text])
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('note://')) onOpenNote(href.slice('note://'.length))
  }
  return <div className="bubble-msg-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

export function BubbleView() {
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const lastAsk = useRef('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [confirmQuit, setConfirmQuit] = useState(false)
  // With no brain downloaded there is nothing to ask; say so up front instead
  // of taking the question and failing it.
  const [hasBrain, setHasBrain] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Transparent window: only what this view draws exists on screen.
  useEffect(() => {
    document.body.classList.add('bubble-host')
    return () => document.body.classList.remove('bubble-host')
  }, [])

  useEffect(() => {
    void api.engines().then((list) => setHasBrain(list.length > 0))
  }, [])

  useEffect(() => {
    return api.onEvent((event) => {
      if (event.type === 'engines:changed') setHasBrain(event.engines.length > 0)
      // Not busy means nothing of ours is running: a stream still arriving is
      // one we already stopped, and must not write into a newer bubble.
      if (!busyRef.current) return
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
        busyRef.current = false
        setBusy(false)
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false }
          return next
        })
      } else if (event.type === 'chat:error' && event.channel === 'bubble') {
        busyRef.current = false
        setBusy(false)
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
          { role: 'assistant', text: event.message, error: true },
        ])
      }
    })
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    if (distance < 120) list.scrollTo({ top: list.scrollHeight })
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

  useEffect(() => {
    const box = inputRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`
  }, [text])

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

  const ask = async (message: string) => {
    if (!message || busy) return
    lastAsk.current = message
    busyRef.current = true
    setBusy(true)
    const history = messages.filter((m) => !m.streaming && !m.error)
    setMessages((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true }])
    try {
      // engineId '' → the main process falls back to the first connected engine.
      await api.chatSend({ engineId: '', message, history, channel: 'bubble' })
    } catch (err) {
      // A rejected send used to leave the placeholder spinning with no way back.
      busyRef.current = false
      setBusy(false)
      setMessages((prev) => [
        ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
        { role: 'assistant', text: String((err as Error).message ?? err), error: true },
      ])
    }
  }

  const send = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    const message = text.trim()
    if (!message) return
    setText('')
    await ask(message)
  }

  const stop = async () => {
    busyRef.current = false
    await api.chatAbort('bubble').catch(() => undefined)
    setBusy(false)
    setMessages((prev) =>
      prev.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || t('bubble.stopped') } : m)),
    )
  }

  const retry = async () => {
    const again = lastAsk.current
    if (!again) return
    setMessages((prev) => prev.filter((m) => !m.error))
    await ask(again)
  }

  if (!expanded) {
    return (
      <div
        className="bubble-dot"
        data-testid="bubble-dot"
        role="button"
        tabIndex={0}
        aria-label={t('bubble.open')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void expand()
          }
        }}
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
        {messages.length === 0 && (
          <div className="bubble-hint">
            {hasBrain ? (
              t('bubble.hint')
            ) : (
              <>
                {t('bubble.noBrain')}
                <button className="bubble-retry" onClick={() => void api.bubbleSetup()}>
                  <Download size={11} strokeWidth={2} aria-hidden /> {t('bubble.getBrain')}
                </button>
              </>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? (
              m.error ? (
                <span className="bubble-fail">
                  {m.text}
                  <button className="bubble-retry" onClick={() => void retry()}>
                    <RotateCcw size={11} strokeWidth={2} aria-hidden /> {t('bubble.retry')}
                  </button>
                </span>
              ) : m.streaming && !m.text ? (
                // The first answer after a cold start waits on the model itself;
                // the clock is the only evidence here, so the wording follows it.
                <Thinking label={(s) => t(s < 6 ? 'bubble.thinking' : s < 20 ? 'bubble.thinkingLong' : 'bubble.thinkingCold')} />
              ) : (
                <Bubble text={m.text} onOpenNote={openNote} />
              )
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>
      <form className="bubble-write" onSubmit={send}>
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send(e)
          }}
          placeholder={hasBrain ? t('bubble.placeholder') : t('bubble.noBrainPlaceholder')}
          maxLength={2000}
          disabled={!hasBrain}
        />
        {busy ? (
          <button type="button" className="chat-send-btn armed bubble-send bubble-stop" aria-label={t('bubble.stop')} title={t('bubble.stop')} onClick={() => void stop()}>
            <Square size={11} strokeWidth={2.5} aria-hidden />
          </button>
        ) : (
          <button type="submit" className="chat-send-btn armed bubble-send" aria-label={t('bubble.send')} disabled={!text.trim()}>
            <ArrowUp size={15} />
          </button>
        )}
      </form>
    </div>
  )
}
