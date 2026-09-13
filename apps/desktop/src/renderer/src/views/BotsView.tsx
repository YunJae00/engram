import { Clock, Play, X } from 'lucide-react'
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, ChatAttachmentDto } from '../../../shared/types.js'
import { sendCometMessage } from '../lib/attachments.js'
import { api } from '../api.js'
import { Choices } from '../components/Choices.js'
import { CometOffer } from '../components/CometOffer.js'
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
import { CometSurface } from '../components/CometSurface.js'
import { PressGate } from '../components/PressGate.js'
import { SubmitGate } from '../components/SubmitGate.js'
import { RoutineProgress } from '../components/RoutineProgress.js'
import { BotComposer } from '../components/BotComposer.js'
import { useCometState, useShellState } from '../state-slices.js'
import { t } from '../i18n.js'
import { CometWelcome } from '../components/CometWelcome.js'

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
  const { showToast } = useShellState()
  const [bots, setBots] = useState<BotDto[]>([])
  const [memoryOpen, setMemoryOpen] = useState(false)
  // What the model is doing, from main's own word. Only 'loading' changes
  // what the thread says, and 'loading' is only ever learned from a live
  // broadcast — a missed one degrades to the plain line, never to a claim.
  const listRef = useRef<HTMLDivElement | null>(null)
  const selectedId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const selected = bots.find((b) => b.id === selectedId) ?? null
  const { messages, loaded: threadLoaded, busy, workLines, keptWork, offer, draft, startedAt } = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(selected?.id ?? null))
  // One local model answers one comet at a time: while another comet holds
  // it, the box says so instead of swallowing a send in silence.
  // Each comet works on its own tab with its own brain session: only this
  // thread's own turn locks its composer.
  const locked = false

  // The wait, said from evidence - see pendingStatus for the order it trusts.
  const latestStep = workLines[workLines.length - 1]
  const status = pendingStatus(t, latestStep)

  // Until the first read comes back, an empty list means "not read yet",
  // and the screen says nothing rather than "no comets" - a claim it cannot
  // make - before turning into the list a moment later.
  const [loaded, setLoaded] = useState(false)
  const reloadGeneration = useRef(0)
  const reload = async () => {
    const generation = ++reloadGeneration.current
    const selectedBefore = cometThreads.getSnapshot().selectedId
    const list = await api.botsList()
    if (generation !== reloadGeneration.current) return
    setBots(list)
    setLoaded(true)
    const current = cometThreads.getSnapshot().selectedId
    if (current && current === selectedBefore && !list.some((b) => b.id === current)) selectComet(null)
  }

  useEffect(() => {
    void reload()
    // A comet named by its first words shows the new name without a press.
    const off = api.onEvent((event) => {
      if (event.type === 'bots:changed') void reload()
    })
    return () => { reloadGeneration.current++; off() }
  }, [])

  // Selecting a comet shows what the store already holds and refreshes it
  // from disk underneath; a turn still streaming stays on top of the reload.
  useEffect(() => {
    setMemoryOpen(false)
    if (selectedId) void loadCometThread(selectedId).catch(() => undefined)
  }, [selectedId])

  useStickToBottom(listRef, messages, selectedId)
  // The bubble the current work belongs to: the last one the comet wrote.
  const lastAssistant = messages.reduce((found, m, i) => (m.role === 'assistant' ? i : found), -1)

  // A tapped choice goes the same way as typed words: through the thread,
  // so the comet hears it with the conversation behind it.
  const sendText = async (message: string, attachments: ChatAttachmentDto[] = []) => {
    if ((!message && !attachments.length) || busy || !selected) return
    await sendCometMessage(api, cometThreads, selected.id, message, attachments)
  }

  const stop = async () => {
    if (!selected) return
    cometThreads.stop(selected.id, t('bubble.stopped'))
    await api.chatAbort(cometChannel(selected.id)).catch(() => undefined)
  }

  const taskPending = useRef(false)
  const runTask = async (task: { id: string; name: string; goal: string; routineId?: string }) => {
    if (!selected || taskPending.current) return
    taskPending.current = true
    try {
      if (task.routineId) {
        await startRoutine(task.routineId, task.name)
        return
      }
      const bot = await api.botCreate({ name: task.name, purpose: '' })
      await api.botTaskRan(selected.id, task.id).catch(() => undefined)
      const history = cometThreads.begin(bot.id, task.goal)
      selectComet(bot.id)
      try { await api.chatSend({ engineId: '', message: task.goal, history, channel: cometChannel(bot.id), botId: bot.id }) }
      catch (error) { if (cometThreads.thread(bot.id).busy) cometThreads.fail(bot.id, String(error)) }
    } finally { taskPending.current = false }
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

  return (
    <div className="bots-view" data-testid="bots-view">
      <section className="bots-main">
        {selected ? (
          <>
          {/* Keyed by the comet: looking at another one brings its thread
              in with a short rise, the way a page turns, not a swap. */}
          <div className="bots-chat" key={selected.id}>
            {(selected.tasks ?? []).length > 0 && (
            <div className="bots-tasks">
              {(selected.tasks ?? []).map((task) => (
                <button
                  key={task.id}
                  className="bots-task"
                  data-testid={`bot-task-${task.id}`}
                  title={task.goal}
                  onClick={() => void runTask(task).catch(error => showToast(String(error)))}
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
            <div className="bots-thread conversation-thread" data-testid="bots-thread" ref={listRef}>
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
                    void startRoutine(wanted.routineId, wanted.name, wanted.force === true, wanted.slots)
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
              <RoutineProgress channel={cometChannel(selected.id)} />
              <SubmitGate channel={cometChannel(selected.id)} />
              {errand.running && (
                <div className="bubble-msg assistant bots-working" data-testid="bots-errand-strip">
                  <ThinkingDots />
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
              memoryOpen={memoryOpen}
              onToggleMemory={() => setMemoryOpen((value) => !value)}
              onSend={(message, attachments) => void sendText(message, attachments)}
              onStop={() => void stop()}
            />
          </div>
          {/* The page the comet works on, beside the conversation: watched,
              acted in, and stoppable right where the work is. */}
          <CometSurface channel={cometChannel(selected.id)} name={selected.name} busy={busy} onStop={() => void stop()}>
            <PressGate channel={cometChannel(selected.id)} />
          </CometSurface>
          </>
        ) : loaded ? (
          <CometWelcome />
        ) : (
          <div className="bots-empty bots-loading" data-testid="bots-loading" aria-busy="true">
            <ThinkingDots />
          </div>
        )}
      </section>
    </div>
  )
})
