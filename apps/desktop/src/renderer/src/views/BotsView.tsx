import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, ChatAttachmentDto } from '../../../shared/types.js'
import { CHIP_FAILED, sendCometMessage, sendCometReply } from '../lib/attachments.js'
import { api } from '../api.js'
import { CometMessages } from '../components/CometMessages.js'
import { ThreadOffers } from '../components/ThreadOffers.js'
import { isSaidLine, isYouLine, pendingStatus, stepLabel } from '../lib/pendingStatus.js'
import { stoppedText, threadLang, threadT } from '../lib/threadLang.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'
import { useLoadEarlier } from '../lib/useLoadEarlier.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, loadCometThread, selectComet } from '../lib/cometThreadsLive.js'
import { ThinkingDots } from '../components/Thinking.js'
import { PreviewDeck } from '../components/PreviewDeck.js'
import { usePreviewFrames } from '../components/usePreviewFrames.js'
import { useCompactBrowser } from '../lib/useCompactBrowser.js'
import { CometSurface } from '../components/CometSurface.js'
import { ThreadAsks } from '../components/ThreadAsks.js'
import { PermissionCard } from '../components/PermissionCard.js'
import { BotComposer } from '../components/BotComposer.js'
import { useShellState } from '../state-slices.js'
import { CometWelcome } from '../components/CometWelcome.js'
import { BotEmpty } from '../components/BotEmpty.js'
import { takeOnboardBot } from '../lib/onboardBot.js'

// The first tab: bots as colleagues, not a feature behind a palette. Each bot
// is a charter over the same brain — its own conversation, the vault behind
// every answer, and the errand pipeline as hands. The rail's suggestions grow
// from the folders the user actually works in, so the empty state is an offer,
// not a lecture. The conversations themselves live in cometThreads, outside
// this component: the tab unmounts on every switch and they must not.


export const BotsView = memo(function BotsView({ active }: { active: boolean }) {
  const { showToast } = useShellState()
  const [bots, setBots] = useState<BotDto[]>([])
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
  const frames = usePreviewFrames(cometChannel(selected?.id ?? ''))
  const { compact } = useCompactBrowser()
  const locked = false

  const latestStep = workLines[workLines.length - 1]
  const status = pendingStatus(threadT(threadLang(messages)))

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
    const handoff = takeOnboardBot()
    const primary = handoff && list.find((b) => b.primary === true)
    if (handoff && primary) {
      selectComet(primary.id)
      const patch = {
        ...(handoff.name !== null && handoff.name !== primary.name ? { name: handoff.name } : {}),
        ...(handoff.label !== null && handoff.label !== primary.label ? { label: handoff.label } : {}),
      }
      if (Object.keys(patch).length) void api.botUpdate(primary.id, patch).catch(() => undefined)
    }
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
    if (selectedId) void loadCometThread(selectedId).catch(() => undefined)
  }, [selectedId])

  const older = cometThreads.thread(selected?.id ?? null).older
  useStickToBottom(listRef, messages.slice(older), selectedId)
  useLoadEarlier(listRef, selected?.id ?? null, older)
  // The bubble the current work belongs to: the last one the comet wrote.

  // A tapped choice goes the same way as typed words: through the thread,
  // so the comet hears it with the conversation behind it.
  const sendText = async (message: string, attachments: ChatAttachmentDto[] = []) => {
    if ((!message && !attachments.length) || !selected) return
    await sendCometMessage(api, cometThreads, selected.id, message, attachments)
  }

  const sendChip = (label: string): boolean => {
    if (selected && sendCometReply(api, cometThreads, selected.id, label)) return true
    showToast(CHIP_FAILED)
    return false
  }

  const stop = async () => {
    if (!selected) return
    const tt = threadT(threadLang(messages))
    const said = cometThreads.stop(selected.id, stoppedText(messages, !latestStep ? undefined : isSaidLine(latestStep) || isYouLine(latestStep) ? pendingStatus(tt) : stepLabel(tt, latestStep)), tt('bubble.stopped'))
    await api.chatAbort(cometChannel(selected.id), said).catch(() => undefined)
  }

  return (
    <div className="bots-view" data-testid="bots-view">
      <section className="bots-main">
        {selected ? (
          <>
          {/* Keyed by the comet: looking at another one brings its thread
              in with a short rise, the way a page turns, not a swap. */}
          <div className="bots-chat" key={selected.id}>
            <PreviewDeck overlay active={active} frames={frames} compact={compact} key={selected.id} lane={cometChannel(selected.id)} busy={busy} lang={threadLang(messages)} state={messages.at(-1)?.error ? 'stopped' : offer?.kind === 'asked' ? 'waiting' : 'recorded'} />
            <div className="bots-thread conversation-thread" data-testid="bots-thread" ref={listRef}>
              {/* A thread not yet read says nothing; only one read and found empty invites the first question. */}
              {messages.length === 0 && threadLoaded && <BotEmpty bot={selected} />}
              <CometMessages firstKey={-older} messages={messages} busy={busy} status={status} since={startedAt ?? undefined} workLines={workLines} keptWork={keptWork}> 
                <ThreadOffers botId={selected.id} onSend={sendChip} />
                <ThreadAsks botId={selected.id} questionShown={!busy && messages.at(-1)?.role === 'assistant' && !messages.at(-1)?.streaming ? messages.at(-1)?.text : undefined} failureShown={!!messages.at(-1)?.error} />
                <PermissionCard lane={cometChannel(selected.id)} />
              </CometMessages>
            </div>
            <BotComposer
              key={selected.id}
              botId={selected.id}
              initialDraft={active ? cometThreads.thread(selected.id).draft : draft}
              busy={busy}
              locked={locked}
              onSend={(message, attachments) => void sendText(message, attachments)}
              onStop={() => void stop()}
            />
          </div>
          {/* The page the comet works on, beside the conversation: watched,
              acted in, and stoppable right where the work is. */}
          <CometSurface channel={cometChannel(selected.id)} name={selected.name} busy={busy} onStop={() => void stop()} />
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
