import { Orbit, PanelRightClose } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { ChatTurnDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { Thinking } from './Thinking.js'
import { ChatComposer } from './ChatComposer.js'

// The cosmos's right edge: ask the librarian, or just tell it something to
// keep. There is no separate "Remember" verb — the librarian files whatever
// the answer marks for keeping, so "remember X" in the box is the capture.

interface Message extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
}

const CHANNEL = 'cosmos'
const COLLAPSED_KEY = 'engram.cosmos-chat.collapsed'
const CLOSE_MS = 160

function streamingAt(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'assistant' && m.streaming) return i
  }
  return -1
}

export const CosmosChat = memo(function CosmosChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const tokenBuffer = useRef('')
  const tokenFrame = useRef(0)

  const openChat = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
    setClosing(false)
    setCollapsed(false)
  }

  const closeChat = () => {
    if (closing) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setClosing(false)
      setCollapsed(true)
    }, CLOSE_MS)
  }

  const flushTokens = () => {
    tokenFrame.current = 0
    const chunk = tokenBuffer.current
    tokenBuffer.current = ''
    if (!chunk) return
    setMessages((prev) => {
      const at = streamingAt(prev)
      if (at < 0) return prev
      const next = [...prev]
      next[at] = { ...next[at]!, text: next[at]!.text + chunk }
      return next
    })
  }

  const clearTokenFrame = () => {
    if (tokenFrame.current) cancelAnimationFrame(tokenFrame.current)
    tokenFrame.current = 0
    tokenBuffer.current = ''
  }

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  // The starter chips and the help panel both aim here.
  useEffect(() => {
    const focus = (event: Event) => {
      const seed = (event as CustomEvent<{ seed?: string }>).detail?.seed
      openChat()
      if (seed) setText(seed)
      setTimeout(() => boxRef.current?.focus(), 80)
    }
    window.addEventListener('engram:focus-capture', focus)
    return () => window.removeEventListener('engram:focus-capture', focus)
  }, [])

  useEffect(() => {
    const unsubscribe = api.onEvent((event) => {
      if (!busyRef.current) return
      if (event.type === 'chat:token' && event.channel === CHANNEL) {
        tokenBuffer.current += event.text
        if (!tokenFrame.current) tokenFrame.current = requestAnimationFrame(flushTokens)
      } else if (event.type === 'chat:done' && event.channel === CHANNEL) {
        clearTokenFrame()
        busyRef.current = false
        setBusy(false)
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false }
          return next
        })
      } else if (event.type === 'chat:error' && event.channel === CHANNEL) {
        clearTokenFrame()
        busyRef.current = false
        setBusy(false)
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
          { role: 'assistant', text: event.message, error: true },
        ])
      }
    })
    return () => {
      unsubscribe()
      clearTokenFrame()
    }
  }, [])

  useStickToBottom(listRef, messages)

  const send = async () => {
    const message = text.trim()
    if (!message || busy) return
    setText('')
    busyRef.current = true
    setBusy(true)
    const history = messages.filter((m) => !m.streaming && !m.error)
    setMessages((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true }])
    try {
      await api.chatSend({ engineId: '', message, history, channel: CHANNEL })
    } catch (err) {
      busyRef.current = false
      setBusy(false)
      setMessages((prev) => [
        ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
        { role: 'assistant', text: String((err as Error).message ?? err), error: true },
      ])
    }
  }

  const stop = async () => {
    busyRef.current = false
    await api.chatAbort(CHANNEL).catch(() => undefined)
    setBusy(false)
    setMessages((prev) =>
      prev.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || t('bubble.stopped') } : m)),
    )
  }

  // The conversation floats over the map so opening it never relayouts the
  // graph or moves the point the person was looking at.
  if (collapsed) {
    return (
      <div className="cosmos-chat-launcher" data-testid="cosmos-chat-folded">
        <button
          className="cosmos-chat-launch"
          data-testid="cosmos-chat-open"
          title={t('cosmos.chatOpen')}
          aria-label={t('cosmos.chatOpen')}
          onClick={openChat}
        >
          <Orbit size={15} strokeWidth={1.8} aria-hidden />
          <span>{t('cosmos.chatOpen')}</span>
        </button>
      </div>
    )
  }

  return (
    <aside className={`cosmos-chat${closing ? ' closing' : ''}`} data-testid="cosmos-chat">
      <div className="cosmos-chat-head">
        <div className="cosmos-chat-identity">
          <span className="cosmos-chat-mark"><Orbit size={15} strokeWidth={1.8} aria-hidden /></span>
          <span className="cosmos-chat-labels">
            <span className="cosmos-chat-name">{t('cosmos.chatName')}</span>
            <span className="cosmos-chat-title">{t('cosmos.chatTitle')}</span>
          </span>
        </div>
        <button
          className="rail-toggle"
          data-testid="cosmos-chat-collapse"
          title={t('cosmos.chatCollapse')}
          onClick={closeChat}
        >
          <PanelRightClose size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      <div className="cosmos-chat-thread" ref={listRef}>
        {messages.length === 0 && <div className="cosmos-chat-hint">{t('cosmos.chatHint')}</div>}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? (
              m.streaming && !m.text ? (
                <Thinking label={t('bubble.thinking')} />
              ) : (
                <StreamingAnswer text={m.text} done={!m.streaming} />
              )
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>
      <div className="cosmos-chat-write">
        <ChatComposer
          ref={boxRef}
          testId="cosmos-chat-input"
          maxLength={4000}
          placeholder={t('cosmos.chatPlaceholder')}
          value={text}
          busy={busy}
          onChange={setText}
          onSend={() => void send()}
          onStop={() => void stop()}
        />
      </div>
    </aside>
  )
})
