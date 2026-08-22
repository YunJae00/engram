import { ArrowUp, Bookmark, Globe, PanelLeftClose, PanelLeftOpen, Play, Plus, Repeat, Square, Trash2, Wand2, X } from 'lucide-react'
import { Comet } from '../components/Icon.js'
import { useEffect, useRef, useState } from 'react'
import type { BotDto, BotSuggestionDto, ChatTurnDto, EngramEvent } from '../../../shared/types.js'
import { api } from '../api.js'
import type { StringKey } from '../i18n.js'
import { answerHtml } from '../markdown.js'
import { SubmitGate } from '../components/SubmitGate.js'
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
  const { errand, startErrand, routine, startRoutine, t } = useApp()
  const [bots, setBots] = useState<BotDto[]>([])
  const [suggestions, setSuggestions] = useState<BotSuggestionDto[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // The loop's narration: one line per tool step, shown under the thinking
  // bubble while the comet works, cleared when the answer lands.
  const [workLines, setWorkLines] = useState<string[]>([])
  // The comet found the procedure for this request but stopped short of
  // running it. Rather than send the person hunting for it, the thread offers
  // the run — one press, with whatever blanks the comet worked out.
  const [offer, setOffer] = useState<Extract<EngramEvent, { type: 'chat:done' }>['offer'] | null>(null)
  const busyChannel = useRef<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPurpose, setDraftPurpose] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('engram.comets.rail') !== '0')
  const [addingTask, setAddingTask] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskGoal, setTaskGoal] = useState('')
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
      if (event.type === 'comet:step' && event.channel === busyChannel.current) {
        setWorkLines((prev) => [...prev.slice(-5), event.line])
      } else if (event.type === 'chat:token' && event.channel === busyChannel.current) {
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
        setWorkLines([])
        setOffer(event.offer ?? null)
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
        setWorkLines([])
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
    if (!message || busy || errand.running || !selected) return
    setText('')
    setBusy(true)
    setWorkLines([])
    setOffer(null)
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

  // A task is the repeated work itself: saved on the comet, one click to run.
  // The errand pipeline is only the engine underneath.
  const runTask = (task: { id: string; name: string; goal: string }) => {
    if (!selected || errand.running) return
    setMessages((prev) => [...prev, { role: 'user', text: task.goal }])
    void api.botTaskRan(selected.id, task.id).catch(() => undefined)
    void startErrand(task.goal, selected.id)
  }

  // What a chat answer leaves you wanting: the web, when the vault did not
  // have it, and a way to keep the ask if it is one you will make again. Both
  // are one press, and both are the person's call — the model never decides to
  // go browsing on its own.
  const lastAsk = (): string => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messages[i]!.text
    return ''
  }

  const searchWeb = () => {
    const goal = lastAsk()
    if (!goal || !selected || errand.running || busy) return
    void startErrand(goal, selected.id)
  }

  const keepAsTask = () => {
    const goal = lastAsk()
    if (!goal) return
    setTaskGoal(goal)
    setTaskName(goal.slice(0, 40))
    setAddingTask(true)
  }

  const addTask = async () => {
    if (!selected || !taskName.trim() || !taskGoal.trim()) return
    await api.botTaskAdd(selected.id, { name: taskName, goal: taskGoal }).catch(() => undefined)
    setTaskName('')
    setTaskGoal('')
    setAddingTask(false)
    await reload()
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

  useEffect(() => {
    localStorage.setItem('engram.comets.rail', railOpen ? '1' : '0')
  }, [railOpen])

  return (
    <div className="bots-view" data-testid="bots-view">
      {!railOpen && (
        <aside className="side-rail folded" data-testid="comets-rail-folded">
        <button className="rail-reopen" data-testid="comets-rail-open" title={t('rail.show')} onClick={() => setRailOpen(true)}>
          <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden />
        </button>
        </aside>
      )}
      {railOpen && (
      <aside className="bots-rail">
        <div className="bots-rail-head">
          <span>{t('bots.railTitle')}</span>
          <button className="rail-collapse" data-testid="comets-rail-close" title={t('rail.hide')} onClick={() => setRailOpen(false)}>
            <PanelLeftClose size={14} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        <ul className="bots-list">
          {bots.map((bot) => (
            <li key={bot.id}>
              <button
                className={`bots-row${bot.id === selectedId ? ' active' : ''}`}
                data-testid={`bot-${bot.id}`}
                onClick={() => setSelectedId(bot.id)}
              >
                <Comet size={14} />
                <span className="bots-row-name">{bot.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <div className="bots-create" data-testid="bots-create">
            <input
              autoFocus
              data-testid="bots-name"
              placeholder={t('bots.nameLabel')}
              value={draftName}
              maxLength={60}
              onChange={(e) => setDraftName(e.target.value)}
            />
            <textarea
              data-testid="bots-purpose"
              placeholder={t('bots.purposeLabel')}
              value={draftPurpose}
              maxLength={500}
              rows={3}
              onChange={(e) => setDraftPurpose(e.target.value)}
            />
            {(!draftName.trim() || !draftPurpose.trim()) && (
              // A disabled button with no reason reads as a broken button —
              // this says which of the two fields is still empty.
              <div className="bots-create-need">
                {t(!draftName.trim() ? 'bots.needName' : 'bots.needPurpose')}
              </div>
            )}
            <div className="bots-create-actions">
              <button
                className="primary"
                data-testid="bots-create-submit"
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
        {/* The other half of "work you repeat": the browser jobs. It lives in
            the rail because it must be reachable before any comet exists — a
            keyboard chord was the only way in, so nobody found it. */}
        <button
          className="bots-new bots-routines"
          data-testid="bots-open-routines"
          title={t('bots.routinesHint')}
          onClick={() => window.dispatchEvent(new Event('engram:open-routines'))}
        >
          <Repeat size={13} strokeWidth={2} aria-hidden /> {t('bots.routines')}
        </button>
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
      )}

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
            <div className="bots-tasks">
              {(selected.tasks ?? []).map((task) => (
                <button
                  key={task.id}
                  className="bots-task"
                  data-testid={`bot-task-${task.id}`}
                  disabled={errand.running}
                  title={task.goal}
                  onClick={() => runTask(task)}
                >
                  <Play size={11} strokeWidth={2.2} aria-hidden />
                  {task.name}
                  <span
                    className="bots-task-x"
                    role="button"
                    aria-label={t('bots.taskRemove')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void api.botTaskRemove(selected.id, task.id).then(() => reload())
                    }}
                  >
                    <X size={10} strokeWidth={2.4} aria-hidden />
                  </span>
                </button>
              ))}
              {addingTask ? (
                <span className="bots-task-new">
                  <input
                    autoFocus
                    data-testid="bot-task-name"
                    placeholder={t('bots.taskName')}
                    value={taskName}
                    maxLength={60}
                    onChange={(e) => setTaskName(e.target.value)}
                  />
                  <input
                    data-testid="bot-task-goal"
                    placeholder={t('bots.taskGoal')}
                    value={taskGoal}
                    maxLength={500}
                    onChange={(e) => setTaskGoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addTask()
                    }}
                  />
                  <button className="primary" data-testid="bot-task-save" disabled={!taskName.trim() || !taskGoal.trim()} onClick={() => void addTask()}>
                    {t('bots.taskSave')}
                  </button>
                  <button className="secondary" onClick={() => setAddingTask(false)}>
                    {t('palette.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  className="bots-task-add"
                  data-testid="bot-task-add"
                  title={t('bots.taskHint')}
                  onClick={() => setAddingTask(true)}
                >
                  <Plus size={11} strokeWidth={2.2} aria-hidden /> {t('bots.taskAdd')}
                </button>
              )}
            </div>
            <div className="bots-thread" ref={listRef}>
              {messages.length === 0 && <div className="bots-hint">{t('bots.threadEmpty', { name: selected.name })}</div>}
              {messages.map((m, i) => (
                <div key={i} className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
                  {m.role === 'assistant' ? (
                    m.streaming && !m.text ? (
                      <span className="bubble-thinking">
                        …
                        {workLines.length > 0 && (
                          <span className="bots-work-lines" data-testid="bots-work-lines">
                            {workLines.map((line, x) => (
                              <span key={`${x}-${line}`} className="bots-work-line">
                                {line}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    ) : (
                      <div className="bubble-msg-body" dangerouslySetInnerHTML={{ __html: answerHtml(m.text) }} />
                    )
                  ) : (
                    m.text
                  )}
                </div>
              ))}
              {!busy && !errand.running && messages.length > 0 && messages[messages.length - 1]!.role === 'assistant' && (
                <div className="bots-followups" data-testid="bots-followups">
                  <button className="bots-followup" data-testid="bots-search-web" onClick={searchWeb}>
                    <Globe size={12} strokeWidth={2} aria-hidden /> {t('bots.searchWeb')}
                  </button>
                  <button className="bots-followup" data-testid="bots-keep-task" onClick={keepAsTask}>
                    <Bookmark size={12} strokeWidth={2} aria-hidden /> {t('bots.keepAsTask')}
                  </button>
                </div>
              )}
              {offer && !routine.running && (
                <div className="bots-offer" data-testid="bots-offer">
                  <span className="bots-offer-text">
                    {offer.kind === 'run' ? t('bots.offerRun', { name: offer.name }) : t('bots.offerTeach')}
                  </span>
                  {offer.kind === 'run' ? (
                    <button
                      className="primary bots-offer-run"
                      data-testid="bots-offer-run"
                      onClick={() => {
                        const wanted = offer
                        setOffer(null)
                        void startRoutine(wanted.routineId, wanted.name, false, wanted.slots)
                      }}
                    >
                      <Play size={11} strokeWidth={2.5} aria-hidden /> {t('routines.run')}
                    </button>
                  ) : (
                    <button
                      className="primary bots-offer-run"
                      data-testid="bots-offer-teach"
                      onClick={() => {
                        setOffer(null)
                        window.dispatchEvent(new CustomEvent('engram:open-routines', { detail: { teach: true } }))
                      }}
                    >
                      <Wand2 size={11} strokeWidth={2.5} aria-hidden /> {t('bots.offerTeachGo')}
                    </button>
                  )}
                </div>
              )}
              <SubmitGate />
              {errand.running && (
                <div className="bubble-msg assistant bots-working" data-testid="bots-errand-strip">
                  <span className="bots-errand-pulse">
                    <Comet size={14} />
                  </span>
                  <span className="bots-working-body">
                    <span className="bots-working-line">
                      {t('bots.errandRunning', {
                        phase: errand.phase && PHASE_LABEL[errand.phase] ? t(PHASE_LABEL[errand.phase]!) : '…',
                      })}
                    </span>
                    {errand.pages && errand.pages.length > 0 ? (
                      <span className="bots-working-detail">{errand.pages.map((x) => x.title || x.url).join(' · ')}</span>
                    ) : errand.queries ? (
                      <span className="bots-working-detail">{errand.queries.join(' · ')}</span>
                    ) : null}
                  </span>
                  <button className="secondary bots-working-stop" onClick={() => void api.errandAbort()}>
                    {t('errands.stop')}
                  </button>
                </div>
              )}
            </div>
            <div className="bots-write">
              <textarea
                value={text}
                rows={1}
                placeholder={errand.running ? t('errands.busy') : t('bots.placeholder', { name: selected.name })}
                maxLength={2000}
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
                <button className="chat-send-btn armed" aria-label={t('chat.send')} disabled={!text.trim()} onClick={() => void send()}>
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="bots-empty">
            <Comet size={30} />
            <div className="bots-empty-title">{t('bots.emptyTitle')}</div>
            <div className="bots-empty-hint">{t('bots.emptyHint')}</div>
          </div>
        )}
      </section>
    </div>
  )
}
