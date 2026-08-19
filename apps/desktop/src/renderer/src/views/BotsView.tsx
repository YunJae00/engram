import { ArrowUp, Ghost, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BotDto, BotSuggestionDto, ChatTurnDto } from '../../../shared/types.js'
import { api } from '../api.js'
import type { StringKey } from '../i18n.js'
import { answerHtml } from '../markdown.js'
import { useApp } from '../state.js'

// The first tab: bots as colleagues, not a feature behind a palette. Each bot
// is a charter over the same brain — its own conversation, the vault behind
// every answer, and the errand pipeline as hands. The rail's suggestions grow
// from the folders the user actually works in, so the empty state is an offer,
// not a lecture.

interface Message extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
}

const PHASE_LABEL: Record<string, StringKey> = {
  plan: 'topbar.errandPlan',
  gather: 'topbar.errandGather',
  web: 'topbar.errandWeb',
  distill: 'topbar.errandDistill',
  compose: 'topbar.errandCompose',
}

function streamingAt(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'assistant' && m.streaming) return i
  }
  return -1
}

export function BotsView() {
  const { errand, startErrand, t } = useApp()
  const [bots, setBots] = useState<BotDto[]>([])
  const [suggestions, setSuggestions] = useState<BotSuggestionDto[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const busyChannel = useRef<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPurpose, setDraftPurpose] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const selected = bots.find((b) => b.id === selectedId) ?? null

  const reload = async (keepSelection = true) => {
    const [list, recs] = await Promise.all([api.botsList(), api.botsRecommend().catch(() => [])])
    setBots(list)
    setSuggestions(recs)
    if (!keepSelection || !list.some((b) => b.id === selectedId)) setSelectedId(list[0]?.id ?? null)
  }

  useEffect(() => {
    void reload(false)
  }, [])

  // Selecting a bot swaps in its persisted conversation.
  useEffect(() => {
    if (!selectedId) {
      setMessages([])
      return
    }
    let alive = true
    void api.botTranscript(selectedId).then((turns) => {
      if (alive) setMessages(turns.map((turn) => ({ role: turn.role, text: turn.text })))
    })
    return () => {
      alive = false
    }
  }, [selectedId])

  useEffect(() => {
    return api.onEvent((event) => {
      // Streams for the run THIS view started; anything else is another surface.
      if (event.type === 'chat:token' && event.channel === busyChannel.current) {
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: next[at]!.text + event.text }
          return next
        })
      } else if (event.type === 'chat:done' && event.channel === busyChannel.current) {
        busyChannel.current = null
        setBusy(false)
        setMessages((prev) => {
          const at = streamingAt(prev)
          if (at < 0) return prev
          const next = [...prev]
          next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false }
          return next
        })
      } else if (event.type === 'chat:error' && event.channel === busyChannel.current) {
        busyChannel.current = null
        setBusy(false)
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
          { role: 'assistant', text: event.message, error: true },
        ])
      } else if (event.type === 'errand:logged') {
        // A finished errand appends its outcome to the delegating bot's thread.
        const id = selectedId
        if (id) void api.botTranscript(id).then((turns) => setMessages(turns.map((x) => ({ role: x.role, text: x.text }))))
      }
    })
  }, [selectedId])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 140) list.scrollTo({ top: list.scrollHeight })
  }, [messages])

  const send = async () => {
    const message = text.trim()
    if (!message || busy || !selected) return
    setText('')
    setBusy(true)
    busyChannel.current = `bot-${selected.id}`
    const history = messages.filter((m) => !m.streaming && !m.error)
    setMessages((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true }])
    try {
      await api.chatSend({ engineId: '', message, history, channel: `bot-${selected.id}`, botId: selected.id })
    } catch (err) {
      busyChannel.current = null
      setBusy(false)
      setMessages((prev) => [
        ...prev.filter((m) => !(m.role === 'assistant' && m.streaming)),
        { role: 'assistant', text: String((err as Error).message ?? err), error: true },
      ])
    }
  }

  const stop = async () => {
    const channel = busyChannel.current
    busyChannel.current = null
    if (channel) await api.chatAbort(channel).catch(() => undefined)
    setBusy(false)
    setMessages((prev) =>
      prev.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || t('bubble.stopped') } : m)),
    )
  }

  const sendAsErrand = () => {
    const goal = text.trim()
    if (!goal || errand.running || !selected) return
    setText('')
    setMessages((prev) => [...prev, { role: 'user', text: goal }])
    void startErrand(goal, selected.id)
  }

  const create = async (name: string, purpose: string) => {
    const bot = await api.botCreate({ name, purpose }).catch(() => null)
    if (!bot) return
    setCreating(false)
    setDraftName('')
    setDraftPurpose('')
    await reload()
    setSelectedId(bot.id)
  }

  const remove = async (id: string) => {
    await api.botDelete(id).catch(() => undefined)
    setConfirmingDelete(null)
    await reload(false)
  }

  return (
    <div className="bots-view" data-testid="bots-view">
      <aside className="bots-rail">
        <div className="bots-rail-head">{t('bots.railTitle')}</div>
        <ul className="bots-list">
          {bots.map((bot) => (
            <li key={bot.id}>
              <button
                className={`bots-row${bot.id === selectedId ? ' active' : ''}`}
                data-testid={`bot-${bot.id}`}
                onClick={() => setSelectedId(bot.id)}
              >
                <Ghost size={14} strokeWidth={1.8} aria-hidden />
                <span className="bots-row-name">{bot.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <div className="bots-create" data-testid="bots-create">
            <input
              autoFocus
              placeholder={t('bots.nameLabel')}
              value={draftName}
              maxLength={60}
              onChange={(e) => setDraftName(e.target.value)}
            />
            <textarea
              placeholder={t('bots.purposeLabel')}
              value={draftPurpose}
              maxLength={500}
              rows={3}
              onChange={(e) => setDraftPurpose(e.target.value)}
            />
            <div className="bots-create-actions">
              <button
                className="primary"
                disabled={!draftName.trim() || !draftPurpose.trim()}
                onClick={() => void create(draftName, draftPurpose)}
              >
                {t('bots.create')}
              </button>
              <button className="secondary" onClick={() => setCreating(false)}>
                {t('palette.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button className="bots-new" data-testid="bots-new" onClick={() => setCreating(true)}>
            <Plus size={13} strokeWidth={2} aria-hidden /> {t('bots.new')}
          </button>
        )}
        {suggestions.length > 0 && (
          <div className="bots-suggested">
            <div className="bots-rail-head">{t('bots.suggestedTitle')}</div>
            {suggestions.map((rec) => (
              <div key={rec.name} className="bots-suggestion">
                <div className="bots-suggestion-name">{rec.name}</div>
                <div className="bots-suggestion-reason">{rec.reason}</div>
                <button className="secondary" onClick={() => void create(rec.name, rec.purpose)}>
                  {t('bots.accept')}
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <section className="bots-main">
        {selected ? (
          <>
            <header className="bots-head">
              <div className="bots-head-id">
                <span className="bots-head-name">{selected.name}</span>
                <span className="bots-head-purpose" title={selected.purpose}>
                  {selected.purpose}
                </span>
              </div>
              <button
                className={`secondary bots-delete${confirmingDelete === selected.id ? ' armed' : ''}`}
                onBlur={() => setConfirmingDelete(null)}
                onClick={() => (confirmingDelete === selected.id ? void remove(selected.id) : setConfirmingDelete(selected.id))}
              >
                <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                {confirmingDelete === selected.id ? t('bots.deleteArmed') : t('bots.delete')}
              </button>
            </header>
            <div className="bots-thread" ref={listRef}>
              {messages.length === 0 && <div className="bots-hint">{t('bots.threadEmpty', { name: selected.name })}</div>}
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
            {errand.running && (
              <div className="bots-errand-strip" data-testid="bots-errand-strip">
                <Ghost size={13} strokeWidth={1.8} aria-hidden className="bots-errand-pulse" />
                <span className="bots-errand-text">
                  {t('bots.errandRunning', {
                    phase: errand.phase && PHASE_LABEL[errand.phase] ? t(PHASE_LABEL[errand.phase]!) : '…',
                  })}{' '}
                  · {errand.goal}
                </span>
                <button className="secondary" onClick={() => void api.errandAbort()}>
                  {t('errands.stop')}
                </button>
              </div>
            )}
            <div className="bots-write">
              <textarea
                value={text}
                rows={1}
                placeholder={t('bots.placeholder', { name: selected.name })}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button
                className="secondary bots-errand-btn"
                title={errand.running ? t('errands.busy') : t('bots.sendErrand')}
                disabled={!text.trim() || errand.running}
                onClick={sendAsErrand}
              >
                <Ghost size={13} strokeWidth={1.8} aria-hidden /> {t('bots.errandBtn')}
              </button>
              {busy ? (
                <button className="chat-send-btn armed bubble-stop" aria-label={t('bubble.stop')} onClick={() => void stop()}>
                  <Square size={11} strokeWidth={2.5} aria-hidden />
                </button>
              ) : (
                <button className="chat-send-btn armed" aria-label={t('chat.send')} disabled={!text.trim()} onClick={() => void send()}>
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="bots-empty">
            <Ghost size={30} strokeWidth={1.5} aria-hidden />
            <div className="bots-empty-title">{t('bots.emptyTitle')}</div>
            <div className="bots-empty-hint">{t('bots.emptyHint')}</div>
          </div>
        )}
      </section>
    </div>
  )
}
