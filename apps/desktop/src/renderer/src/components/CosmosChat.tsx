import { ArrowUp, PanelRightClose, PanelRightOpen, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatTurnDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { answerHtml } from '../markdown.js'
import { useApp } from '../state.js'

// The cosmos's right edge: ask the librarian, or just tell it something to
// keep. There is no separate "Remember" verb — the librarian files whatever
// the answer marks for keeping, so "remember X" in the box is the capture.

interface Message extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
}

const CHANNEL = 'cosmos'
const COLLAPSED_KEY = 'engram.cosmos-chat.collapsed'

function streamingAt(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'assistant' && m.streaming) return i
  }
  return -1
}

export function CosmosChat() {
  const { t } = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const listRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  // The starter chips and the help panel both aim here.
  useEffect(() => {
    const focus = (event: Event) => {
      const seed = (event as CustomEvent<{ seed?: string }>).detail?.seed
      setCollapsed(false)
      if (seed) setText(seed)
      setTimeout(() => boxRef.current?.focus(), 80)
    }
    window.addEventListener('engram:focus-capture', focus)
    return () => window.removeEventListener('engram:focus-capture', focus)
  }, [])

  useEffect(() => {
    return api.onEvent((event) => {
      if (!busyRef.current) return
      if (event.type === 'chat:token' && event.channel === CHANNEL) {
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: next[at]!.text + event.text }
          return next
        })
      } else if (event.type === 'chat:done' && event.channel === CHANNEL) {
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
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 140) list.scrollTo({ top: list.scrollHeight })
  }, [messages])

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

  if (collapsed) {
    return (
      <button
        className="cosmos-chat-open"
        data-testid="cosmos-chat-open"
        title={t('cosmos.chatOpen')}
        onClick={() => setCollapsed(false)}
      >
        <PanelRightOpen size={15} strokeWidth={1.8} aria-hidden />
      </button>
    )
  }

  return (
    <aside className="cosmos-chat" data-testid="cosmos-chat">
      <div className="cosmos-chat-head">
        <span className="cosmos-chat-title">{t('cosmos.chatTitle')}</span>
        <button className="cosmos-chat-collapse" title={t('cosmos.chatCollapse')} onClick={() => setCollapsed(true)}>
          <PanelRightClose size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      <div className="cosmos-chat-thread" ref={listRef}>
        {messages.length === 0 && <div className="cosmos-chat-hint">{t('cosmos.chatHint')}</div>}
        {messages.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? (
              m.streaming && !m.text ? (
                <span className="bubble-thinking">…</span>
              ) : (
                <div className="bubble-msg-body" dangerouslySetInnerHTML={{ __html: answerHtml(m.text) }} />
              )
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>
      <div className="cosmos-chat-write">
        <textarea
          ref={boxRef}
          data-testid="cosmos-chat-input"
          rows={1}
          maxLength={4000}
          placeholder={t('cosmos.chatPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button className="chat-send-btn armed bubble-stop" aria-label={t('bubble.stop')} onClick={() => void stop()}>
            <Square size={11} strokeWidth={2.5} aria-hidden />
          </button>
        ) : (
          <button
            className="chat-send-btn armed"
            data-testid="cosmos-chat-send"
            aria-label={t('chat.send')}
            disabled={!text.trim()}
            onClick={() => void send()}
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </aside>
  )
}
