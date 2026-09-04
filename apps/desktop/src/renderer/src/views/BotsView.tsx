import { Clock, Orbit, Play, Trash2, X, MessageSquarePlus } from 'lucide-react'
import { Comet } from '../components/Icon.js'
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, BotSuggestionDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { Choices } from '../components/Choices.js'
import { CometOffer } from '../components/CometOffer.js'
import { CometMemory } from '../components/CometMemory.js'
import { CometRail } from '../components/CometRail.js'
import { CometWork } from '../components/CometWork.js'
import { pendingStatus } from '../lib/pendingStatus.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'
import { Fragment } from 'react'
import type { StringKey } from '../i18n.js'
import { cometChannel } from '../lib/cometThreads.js'
import { scheduleLabel } from '../lib/schedule.js'
import { cometThreads, loadCometThread, selectComet } from '../lib/cometThreadsLive.js'
import { StreamingAnswer } from '../components/StreamingAnswer.js'
import { ThinkingDots } from '../components/Thinking.js'
import { WebPane } from '../components/WebPane.js'
import { PressGate } from '../components/PressGate.js'
import { SubmitGate } from '../components/SubmitGate.js'
import { BotComposer } from '../components/BotComposer.js'
import { useCometState } from '../state-slices.js'
import { t } from '../i18n.js'

// The first tab: bots as colleagues, not a feature behind a palette. Each bot
// is a charter over the same brain — its own conversation, the vault behind
// every answer, and the errand pipeline as hands. The rail's suggestions grow
// from the folders the user actually works in, so the empty state is an offer,
// not a lecture. The conversations themselves live in cometThreads, outside
// this component: the tab unmounts on every switch and they must not.

const PHASE_LABEL: Record<string, StringKey> = {
  plan: 'topbar.errandPlan',
  gather: 'topbar.errandGather',
  web: 'topbar.errandWeb',
  distill: 'topbar.errandDistill',
  compose: 'topbar.errandCompose',
}


export const BotsView = memo(function BotsView() {
  const { errand, routine, startRoutine } = useCometState()
  const [bots, setBots] = useState<BotDto[]>([])
  const [suggestions, setSuggestions] = useState<BotSuggestionDto[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('engram.comets.rail') !== '0')
  // What the model is doing, from main's own word. Only 'loading' changes
  // what the thread says, and 'loading' is only ever learned from a live
  // broadcast — a missed one degrades to the plain line, never to a claim.
  const listRef = useRef<HTMLDivElement | null>(null)
  const { selectedId } = useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const selected = bots.find((b) => b.id === selectedId) ?? null
  const { messages, loaded: threadLoaded, busy, workLines, keptWork, offer, draft, startedAt } = cometThreads.thread(selected?.id ?? null)
  // One local model answers one comet at a time: while another comet holds
  // it, the box says so instead of swallowing a send in silence.
  // Each comet works on its own tab with its own brain session, so one
  // being busy locks only itself. An errand run still takes the shared
  // default lane and locks every composer while it runs.
  const locked = errand.running

  // The wait, said from evidence - see pendingStatus for the order it trusts.
  const latestStep = workLines[workLines.length - 1]
  const status = pendingStatus(t, latestStep)

  // Until the first read comes back, an empty list means "not read yet",
  // and the screen says nothing rather than "no comets" - a claim it cannot
  // make - before turning into the list a moment later.
  const [loaded, setLoaded] = useState(false)
  const reload = async (keepSelection = true) => {
    const [list, recs] = await Promise.all([api.botsList(), api.botsRecommend().catch(() => [])])
    setBots(list)
    setSuggestions(recs)
    setLoaded(true)
    const current = cometThreads.getSnapshot().selectedId
    if (!keepSelection || !list.some((b) => b.id === current)) selectComet(list[0]?.id ?? null)
  }

  useEffect(() => {
    void reload()
    // A comet named by its first words shows the new name without a press.
    return api.onEvent((event) => {
      if (event.type === 'bots:changed') void reload()
    })
  }, [])

  // Selecting a comet shows what the store already holds and refreshes it
  // from disk underneath; a turn still streaming stays on top of the reload.
  useEffect(() => {
    setMemoryOpen(false)
    if (selectedId) void loadCometThread(selectedId).catch(() => undefined)
  }, [selectedId])

  useStickToBottom(listRef, messages)
  // The bubble the current work belongs to: the last one the comet wrote.
  const lastAssistant = messages.reduce((found, m, i) => (m.role === 'assistant' ? i : found), -1)

  // A tapped choice goes the same way as typed words: through the thread,
  // so the comet hears it with the conversation behind it.
  const sendText = async (message: string) => {
    if (!message || busy || errand.running || !selected) return
    const id = selected.id
    const history = cometThreads.begin(id, message)
    try {
      await api.chatSend({ engineId: '', message, history, channel: cometChannel(id), botId: id })
    } catch (err) {
      // main may already have said so over chat:error; do not say it twice.
      if (cometThreads.thread(id).busy) cometThreads.fail(id, String((err as Error).message ?? err))
    }
  }

  const stop = async () => {
    if (!selected) return
    cometThreads.stop(selected.id, t('bubble.stopped'))
    await api.chatAbort(cometChannel(selected.id)).catch(() => undefined)
  }

  // A task is the repeated work itself: saved on the comet, one click to run.
  // The errand pipeline is only the engine underneath.
  // A routine is the job done again IN ITS CHAT: the goal goes through the
  // ordinary turn, where the comet finds the recorded procedure and replays
  // the path that worked, filling in by hand only where the page differs.
  // The person watches it in the thread like any other ask.
  const runTaskOf = (botId: string, task: { id: string; name: string; goal: string }) => {
    if (cometThreads.thread(botId).busy) return
    if (botId !== selectedId) selectComet(botId)
    void api.botTaskRan(botId, task.id).catch(() => undefined)
    const history = cometThreads.begin(botId, task.goal)
    void api
      .chatSend({ engineId: '', message: task.goal, history, channel: cometChannel(botId), botId })
      .catch(() => cometThreads.fail?.(botId, 'the turn could not start'))
  }
  const runTask = (task: { id: string; name: string; goal: string }) => {
    if (selected) runTaskOf(selected.id, task)
  }

  // What a chat answer leaves you wanting: the web, when the vault did not
  // have it, and a way to keep the ask if it is one you will make again. Both
  // are one press, and both are the person's call — the model never decides to
  // go browsing on its own.
  // Keeping a job is the loop's suggestion and one click - never a form.
  const keep = async (name: string, goal: string) => {
    if (!selected) return
    await api.botTaskAdd(selected.id, { name, goal }).catch(() => undefined)
    await reload()
  }

  const stand = async (offer: { name: string; goal: string; schedule: { days: number[]; hour: number; minute: number }; routineId: string }) => {
    if (!selected) return
    await api.botTaskAdd(selected.id, { name: offer.name, goal: offer.goal, schedule: offer.schedule, routineId: offer.routineId }).catch(() => undefined)
    await reload()
  }

  const create = async (name: string, purpose: string): Promise<boolean> => {
    const bot = await api.botCreate({ name, purpose }).catch(() => null)
    if (!bot) return false
    await reload()
    selectComet(bot.id)
    return true
  }

  const remove = async (id: string) => {
    await api.botDelete(id).catch(() => undefined)
    setConfirmingDelete(null)
    cometThreads.forget(id)
    await reload(false)
  }

  // The card leaves at once; the vault remembers the refusal so the next
  // reload does not bring it back.
  const dismiss = async (name: string) => {
    setSuggestions((prev) => prev.filter((s) => s.name !== name))
    await api.botSuggestionDismiss(name).catch(() => undefined)
  }

  useEffect(() => {
    localStorage.setItem('engram.comets.rail', railOpen ? '1' : '0')
  }, [railOpen])

  return (
    <div className="bots-view" data-testid="bots-view">
      <CometRail
        bots={bots}
        suggestions={suggestions}
        selectedId={selectedId}
        open={railOpen}
        onToggle={() => setRailOpen(!railOpen)}
        onSelect={selectComet}
        onCreate={create}
        onDismiss={(name) => void dismiss(name)}
        onRunTask={runTaskOf}
        running={errand.running}
      />

      <section className="bots-main">
        {selected ? (
          <>
          {/* Keyed by the comet: looking at another one brings its thread
              in with a short rise, the way a page turns, not a swap. */}
          <div className="bots-chat" key={selected.id}>
            <header className="bots-head">
              <div className="bots-head-id">
                <span className="bots-head-name">{selected.name}</span>
                {selected.purpose && (
                  <span className="bots-head-purpose" title={selected.purpose}>
                    {selected.purpose}
                  </span>
                )}
              </div>
              <div className="bots-head-actions">
                <button
                  className="bots-head-action"
                  data-testid="bots-fresh"
                  title={t('bots.freshHint')}
                  aria-label={t('bots.fresh')}
                  onClick={() => {
                    cometThreads.fresh(selected.id)
                    void api.chatFresh(selected.id).catch(() => undefined)
                  }}
                >
                  <MessageSquarePlus size={16} strokeWidth={1.8} aria-hidden />
                </button>
                <button
                  className={`bots-head-action bots-memory-toggle${memoryOpen ? ' armed' : ''}`}
                  data-testid="bots-memory-toggle"
                  title={t('bots.memory')}
                  aria-label={t('bots.memory')}
                  onClick={() => setMemoryOpen(!memoryOpen)}
                >
                  <Orbit size={16} strokeWidth={1.8} aria-hidden />
                </button>
                <button
                  className={`bots-head-action bots-delete${confirmingDelete === selected.id ? ' armed' : ''}`}
                  title={confirmingDelete === selected.id ? t('bots.deleteArmed') : t('bots.delete')}
                  aria-label={confirmingDelete === selected.id ? t('bots.deleteArmed') : t('bots.delete')}
                  onBlur={() => setConfirmingDelete(null)}
                  onClick={() => (confirmingDelete === selected.id ? void remove(selected.id) : setConfirmingDelete(selected.id))}
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden />
                </button>
              </div>
            </header>
            {memoryOpen && <CometMemory botId={selected.id} name={selected.name} />}
            {(selected.tasks ?? []).length > 0 && (
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
                  {task.schedule ? <Clock size={11} strokeWidth={2.2} aria-hidden /> : <Play size={11} strokeWidth={2.2} aria-hidden />}
                  {task.name}
                  {task.schedule && <span className="bots-task-when">{t('bots.taskStanding', { when: scheduleLabel(task.schedule) })}</span>}
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
            </div>
            )}
            <div className="bots-thread" data-testid="bots-thread" ref={listRef}>
              {/* A thread not yet read says nothing; only one read and found empty invites the first question. */}
              {messages.length === 0 && threadLoaded && <div className="bots-hint">{t('bots.threadEmpty', { name: selected.name })}</div>}
              {messages.map((m, i) => (
                <Fragment key={i}>
                  {/* The work sits above the words it leads to: every step
                      and every aside in order, then the answer under them.
                      Words the comet writes between actions stay where
                      they were written instead of leaping into a list
                      below, and the foot of the thread - where the eye
                      rests - is where it speaks. */}
                  {i === lastAssistant && <CometWork busy={busy} status={status} since={startedAt ?? undefined} lines={workLines} kept={keptWork} />}
                  <div className={`bubble-msg ${m.role}${m.error ? ' error' : ''}`}>
                    {m.role === 'assistant' ? (
                      m.streaming && !m.text ? (
                        <span className="bots-pending" data-testid="bots-pending" />
                      ) : (
                        <StreamingAnswer text={m.text} done={!m.streaming} />
                      )
                    ) : (
                      m.text
                    )}
                  </div>
                </Fragment>
              ))}
              {offer && offer.kind === 'asked' && !routine.running && (
                <Choices
                  options={offer.options}
                  onPick={(label) => {
                    cometThreads.clearOffer(selected.id)
                    void sendText(label)
                  }}
                />
              )}
              {offer && offer.kind !== 'asked' && !routine.running && (
                <CometOffer
                  offer={offer}
                  onKeep={(name, goal) => {
                    cometThreads.clearOffer(selected.id)
                    void keep(name, goal)
                  }}
                  onRun={(wanted) => {
                    cometThreads.clearOffer(selected.id)
                    void startRoutine(wanted.routineId, wanted.name, false, wanted.slots)
                  }}
                  onStand={(wanted) => {
                    cometThreads.clearOffer(selected.id)
                    void stand(wanted)
                  }}
                  onDecline={(wanted) => {
                    cometThreads.clearOffer(selected.id)
                    void api.botStandingDecline(selected.id, wanted.goal).catch(() => undefined)
                  }}
                  onDismiss={() => cometThreads.clearOffer(selected.id)}
                />
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
            <BotComposer
              key={selected.id}
              botId={selected.id}
              botName={selected.name}
              initialDraft={draft}
              busy={busy}
              locked={locked}
              onSend={(message) => void sendText(message)}
              onStop={() => void stop()}
            />
          </div>
          {/* The page the comet works on, beside the conversation: watched,
              acted in, and stoppable right where the work is. */}
          <WebPane channel={cometChannel(selected.id)} busy={busy} onStop={() => void stop()}>
            <PressGate channel={cometChannel(selected.id)} />
          </WebPane>
          </>
        ) : loaded ? (
          <div className="bots-empty">
            <Comet size={30} />
            <div className="bots-empty-title">{t('bots.emptyTitle')}</div>
            <div className="bots-empty-hint">{t('bots.emptyHint')}</div>
          </div>
        ) : (
          <div className="bots-empty bots-loading" data-testid="bots-loading" aria-busy="true">
            <ThinkingDots />
          </div>
        )}
      </section>
    </div>
  )
})
