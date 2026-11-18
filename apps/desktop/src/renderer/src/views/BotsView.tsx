import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, ChatAttachmentDto } from '../../../shared/types.js'
import { sendCometMessage } from '../lib/attachments.js'
import { api } from '../api.js'
import { CometMessages } from '../components/CometMessages.js'
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
import { CometWelcome } from '../components/CometWelcome.js'
import { BotEmpty } from '../components/BotEmpty.js'
import { takeOnboardBot } from '../lib/onboardBot.js'

export const BotsView = memo(function BotsView({ active }: { active: boolean }) {
  const [bots, setBots] = useState<BotDto[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)
  const selectedId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const selected = bots.find((b) => b.id === selectedId) ?? null
  const { messages, loaded: threadLoaded, busy, workLines, keptWork, offer, draft, startedAt } = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(selected?.id ?? null))
  const frames = usePreviewFrames(cometChannel(selected?.id ?? ''))
  const { compact } = useCompactBrowser()
  const locked = false

  const latestStep = workLines[workLines.length - 1]
  const status = pendingStatus(threadT(threadLang(messages)))

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
    const off = api.onEvent((event) => {
      if (event.type === 'bots:changed') void reload()
    })
    return () => { reloadGeneration.current++; off() }
  }, [])

  useEffect(() => {
    if (selectedId) void loadCometThread(selectedId).catch(() => undefined)
  }, [selectedId])

  const older = cometThreads.thread(selected?.id ?? null).older
  useStickToBottom(listRef, messages.slice(older), selectedId)
  useLoadEarlier(listRef, selected?.id ?? null, older)

  const sendText = async (message: string, attachments: ChatAttachmentDto[] = []) => {
    if ((!message && !attachments.length) || !selected) return
    await sendCometMessage(api, cometThreads, selected.id, message, attachments)
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
          <div className="bots-chat" key={selected.id}>
            <PreviewDeck overlay active={active} frames={frames} compact={compact} key={selected.id} lane={cometChannel(selected.id)} busy={busy} lang={threadLang(messages)} state={messages.at(-1)?.error ? 'stopped' : offer?.kind === 'asked' ? 'waiting' : 'recorded'} />
            <div className="bots-thread conversation-thread" data-testid="bots-thread" ref={listRef}>
              {messages.length === 0 && threadLoaded && <BotEmpty bot={selected} />}
              <CometMessages firstKey={-older} messages={messages} busy={busy} status={status} since={startedAt ?? undefined} workLines={workLines} keptWork={keptWork}> 
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
