import { ArrowUp, FileText, MessageCircle, Pin, PlugZap, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { marked } from 'marked'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatTurnDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useApp } from '../state.js'

interface KeptEntry {
  kept: true
  text: string
  pinned: boolean
}

interface ChatMessage extends ChatTurnDto {
  streaming?: boolean
  tokens?: number
  error?: boolean
}

// The transcript interleaves the librarian's answers with the things you told
// it to remember, so an entry is one or the other.
type Entry = ChatMessage | KeptEntry
const isKept = (entry: Entry): entry is KeptEntry => 'kept' in entry

// What another surface wants this panel to start with: the note sheet's "ask
// about this" (ask), a starter chip's scaffold or the help panel's Remember
// action (write). It arrives as a prop, not a window event — the panel is
// unmounted while it rests, so the shell has to hold the intent until there is
// a composer to receive it.
export interface PanelIntent {
  text: string
  ask: boolean
}

interface ChatPanelProps {
  onClose: () => void
  intent?: PanelIntent | null
  onIntentConsumed?: () => void
}

// Open the diagnostics/reconnect overlay from anywhere (the shell listens for
// this — same window-event idiom as engram:toggle-chat).
function openDiagnostics(): void {
  window.dispatchEvent(new Event('engram:open-diagnostics'))
}

// Since remembered items sit in the same list, a token can no longer assume the
// last entry is the bubble it belongs to (type a thought while an answer is
// still streaming and the tokens went nowhere).
function streamingIndex(entries: Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry && !isKept(entry) && entry.role === 'assistant' && entry.streaming) return i
  }
  return -1
}

// Parse each message's markdown once and memoize on its text. Without this every
// streaming token re-parsed the ENTIRE transcript (O(messages × tokens)) on the
// main thread — the chat lag from the feedback. Now only the message whose text
// actually changed re-parses; finished messages don't even re-render.
// note:// links are the librarian's citations — clicking one opens that note
// instead of navigating (the receipt behind the answer).
const ChatBubble = memo(function ChatBubble({ text }: { text: string }) {
  const { openNote } = useApp()
  // A capture marker tail can stream in before main strips it — hide it.
  const visible = text.split('<engram:capture')[0] ?? ''
  const html = useMemo(() => marked.parse(visible || '…', { async: false }) as string, [visible])
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('note://')) openNote(href.slice('note://'.length))
  }
  return <div className="chat-bubble" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

const CHAT_MIN_W = 320
const CHAT_MAX_W = 760
const CHAT_WIDTH_KEY = 'engram.chat.width'

export function ChatPanel({ onClose, intent, onIntentConsumed }: ChatPanelProps) {
  const { engines, notes, sheetNoteId, showToast, refresh, t } = useApp()
  const [entries, setEntries] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [suppressRef, setSuppressRef] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= CHAT_MIN_W ? Math.min(saved, CHAT_MAX_W) : 340
  })
  // Waiting clock: seconds since the question left, shown in the pending
  // bubble so a slow first token reads as "working", never "frozen".
  const [waitSeconds, setWaitSeconds] = useState(0)
  const askedAtRef = useRef(0)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => {
      setWaitSeconds(Math.floor((Date.now() - askedAtRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(CHAT_MAX_W, Math.max(CHAT_MIN_W, startW + (startX - ev.clientX)))
      setWidth(next)
    }
    const onUp = (ev: PointerEvent) => {
      const finalW = Math.min(CHAT_MAX_W, Math.max(CHAT_MIN_W, startW + (startX - ev.clientX)))
      localStorage.setItem(CHAT_WIDTH_KEY, String(finalW))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const focusedNote = sheetNoteId ? notes.find((n) => n.id === sheetNoteId) : undefined
  const activeNote = suppressRef ? undefined : focusedNote

  // The reference chip is opt-out per focused note: unsuppress when focus moves.
  useEffect(() => {
    setSuppressRef(false)
  }, [sheetNoteId])

  useEffect(() => {
    return api.onEvent((event) => {
      // The floating bubble shares the pipeline; its stream is not ours.
      if (event.type === 'chat:token' && event.channel === 'panel') {
        setEntries((prev) => {
          const at = streamingIndex(prev)
          const last = prev[at] as ChatMessage | undefined
          if (!last) return prev
          const next = [...prev]
          next[at] = { ...last, text: last.text + event.text, tokens: (last.tokens ?? 0) + 1 }
          return next
        })
      } else if (event.type === 'chat:done' && event.channel === 'panel') {
        setBusy(false)
        setEntries((prev) => {
          const at = streamingIndex(prev)
          const last = prev[at] as ChatMessage | undefined
          if (!last) return prev
          const next = [...prev]
          next[at] = { ...last, text: event.text, streaming: false }
          return next
        })
      } else if (event.type === 'chat:error' && event.channel === 'panel') {
        setBusy(false)
        setEntries((prev) => [
          ...prev.filter((m) => isKept(m) || !(m.role === 'assistant' && m.streaming)),
          { role: 'assistant', text: event.message, error: true },
        ])
      }
    })
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [entries])

  const sendMessage = async (message: string) => {
    if (!message || busy || engines.length === 0) return
    setBusy(true)
    askedAtRef.current = Date.now()
    setWaitSeconds(0)
    const history = entries.filter((e): e is ChatMessage => !isKept(e) && !e.streaming)
    setEntries((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true, tokens: 0 }])
    await api.chatSend({
      engineId: '',
      message,
      history,
      noteId: activeNote?.id,
      channel: 'panel',
    })
  }

  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault()
    const message = text.trim()
    if (!message) return
    setText('')
    void sendMessage(message)
  }

  // Identity-compared so React 18's double-invoked mount effect cannot ask the
  // same question twice, while a genuinely new intent still gets through.
  const handled = useRef<PanelIntent | null>(null)
  useEffect(() => {
    if (!intent || handled.current === intent) return
    handled.current = intent
    // With no engine the question has nowhere to go — it waits in the composer
    // with the connect CTA right above it, instead of disappearing.
    if (intent.ask && intent.text && engines.length > 0) void sendMessage(intent.text)
    else {
      setText(intent.text)
      setTimeout(() => inputRef.current?.focus(), 60)
    }
    onIntentConsumed?.()
  }, [intent]) // fire once per intent; sendMessage identity churns per render

  const promote = async (text: string) => {
    const result = await api.capture(text)
    showToast(t('toast.promoted'))
    setEntries((prev) => [...prev, { kept: true, text, pinned: !result.processed }])
    await refresh()
  }

  const noEngine = engines.length === 0
  const keptLabel = (entry: KeptEntry): string => (entry.pinned ? t('chat.keptPending') : t('chat.kept'))

  return (
    <aside className="chat-panel" data-testid="chat-panel" style={{ width }}>
      <div className="chat-resize" data-testid="chat-resize" onPointerDown={startResize} />
      <div className="chat-head">
        <span className="chat-title">{t('chat.title')}</span>
        <button className="chat-close" data-testid="chat-close" title={t('topbar.close')} aria-label={t('topbar.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="chat-messages" ref={listRef} data-testid="chat-messages">
        {entries.length === 0 && (
          <div className="chat-empty">
            <MessageCircle size={26} />
            <span>{noEngine ? t('chat.emptyOffline') : t('chat.empty')}</span>
            {noEngine && (
              <button className="chat-connect-cta" data-testid="chat-connect" onClick={openDiagnostics}>
                <PlugZap size={14} strokeWidth={1.8} aria-hidden /> {t('chat.connectAi')}
              </button>
            )}
          </div>
        )}
        {entries.map((entry, i) =>
          isKept(entry) ? (
            <div key={i} className="chat-kept" data-testid="chat-kept">
              <Pin size={11} strokeWidth={2} aria-hidden />
              <span className="chat-kept-label">{keptLabel(entry)}</span>
              {entry.text && <span className="chat-kept-text">{entry.text}</span>}
            </div>
          ) : (
            <div key={i} className={`chat-message ${entry.role}`} data-tokens={entry.tokens ?? 0}>
              {entry.error ? (
                <div className="chat-bubble chat-error">
                  <div className="chat-error-row">
                    <TriangleAlert className="chat-error-icon" size={12} strokeWidth={1.8} aria-hidden />
                    <span>{entry.text}</span>
                  </div>
                  <button className="chat-reconnect" data-testid="chat-reconnect" onClick={openDiagnostics}>
                    <RefreshCw size={11} strokeWidth={1.8} aria-hidden /> {t('chat.reconnect')}
                  </button>
                </div>
              ) : entry.streaming && !entry.text ? (
                // Pre-first-token: retrieval's receipts land here in
                // milliseconds — something true to read (and click) during
                // the seconds the engine takes to start writing. The dots
                // carry a running clock so a slow start reads as thinking.
                <div className="chat-bubble chat-pending">
                  <span className="chat-pending-dots">…</span>
                  {waitSeconds > 0 && <span className="chat-pending-clock">{waitSeconds}s</span>}
                </div>
              ) : (
                <ChatBubble text={entry.text} />
              )}
              {entry.role === 'assistant' && !entry.streaming && entry.text && !entry.error && (
                <button className="pin-button" data-testid={`pin-${i}`} title={t('chat.recordTitle')} onClick={() => void promote(entry.text)}>
                  <Pin size={12} strokeWidth={1.8} aria-hidden /> {t('chat.record')}
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {activeNote && (
        <div className="chat-chips">
          <span className="chat-chip" title={activeNote.title}>
            <FileText size={12} />
            <span className="chat-chip-label">{activeNote.title}</span>
            <button className="chat-chip-x" aria-label={t('topbar.close')} onClick={() => setSuppressRef(true)}>
              <X size={11} />
            </button>
          </span>
        </div>
      )}

      <form className="chat-write" onSubmit={submit}>
        <input
          ref={inputRef}
          data-testid="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={noEngine ? t('chat.connectPlaceholder') : t('chat.placeholder')}
          maxLength={2000}
        />
        <button
          type="submit"
          className="chat-send-btn armed"
          data-testid="chat-send"
          aria-label={t('chat.send')}
          disabled={busy || noEngine || !text.trim()}
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </aside>
  )
}
