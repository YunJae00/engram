import type { ChatTurnDto, EngramEvent } from '../../../shared/types.js'

// Every comet's conversation as the screen shows it, kept outside the view:
// the tab unmounts on each switch, and an answer that is mid-sentence has to
// keep arriving somewhere. Disk holds only settled turns (main appends them
// when an answer completes), so the pending question and its growing reply
// live here until then.

export interface CometMessage extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
}

export type CometOffer = NonNullable<Extract<EngramEvent, { type: 'chat:done' }>['offer']>

export interface CometThread {
  messages: CometMessage[]
  busy: boolean
  workLines: string[]
  // The steps of the turn that just ended, kept so a person can look back at
  // what was done; the next turn clears them.
  keptWork: string[]
  offer: CometOffer | null
  draft: string
  // The seat was taken for an answer this renderer never sent (a reload
  // mid-answer): once it lands, disk is the only complete record of it.
  adopted: boolean
  // The person pressed Stop: the thread settled itself, and the done event
  // main sends for the abort must not be read as news from disk - nothing of
  // this exchange ever reached disk.
  stopped: boolean
  // When the pending answer began, so a clock can survive the view
  // unmounting; null while nothing is pending.
  startedAt: number | null
  // Completions that landed while nobody here was waiting. A seat adopted
  // for an answer that has meanwhile finished would never be released, so an
  // adopt compares this before and after its reads.
  doneSeen: number
}

export interface CometThreadsSnapshot {
  selectedId: string | null
  threads: Readonly<Record<string, CometThread>>
}

export type CometThreadsStore = ReturnType<typeof createCometThreads>

const EMPTY: CometThread = { messages: [], busy: false, workLines: [], keptWork: [], offer: null, draft: '', adopted: false, stopped: false, startedAt: null, doneSeen: 0 }
const CHANNEL_PREFIX = 'bot-'
const WORK_LINES_KEPT = 16

export function cometChannel(botId: string): string {
  return `${CHANNEL_PREFIX}${botId}`
}

export function cometOfChannel(channel: string): string | null {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null
}

function streamingAt(list: CometMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m && m.role === 'assistant' && m.streaming) return i
  }
  return -1
}

// The unsettled tail: the question that was just sent and the reply still
// streaming under it. Everything before it is on disk, or will be.
function pendingTail(list: CometMessage[]): CometMessage[] {
  const at = streamingAt(list)
  if (at < 0) return []
  const before = list[at - 1]
  return before && before.role === 'user' ? list.slice(at - 1) : list.slice(at)
}

export function createCometThreads(initialSelected: string | null = null) {
  let snapshot: CometThreadsSnapshot = { selectedId: initialSelected, threads: {} }
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const thread = (id: string | null): CometThread => (id ? (snapshot.threads[id] ?? EMPTY) : EMPTY)
  const patch = (id: string, next: Partial<CometThread>) => {
    snapshot = { ...snapshot, threads: { ...snapshot.threads, [id]: { ...thread(id), ...next } } }
    emit()
  }
  const settle = (id: string, messages: CometMessage[], extra: Partial<CometThread> = {}) =>
    patch(id, { busy: false, adopted: false, workLines: [], keptWork: thread(id).workLines, startedAt: null, messages, ...extra })
  const fail = (id: string, text: string) =>
    settle(id, [...thread(id).messages.filter((m) => !(m.role === 'assistant' && m.streaming)), { role: 'assistant', text, error: true }])

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: (): CometThreadsSnapshot => snapshot,
    thread,
    anyBusy: (): boolean => Object.values(snapshot.threads).some((one) => one.busy),
    select(id: string | null): void {
      if (id === snapshot.selectedId) return
      snapshot = { ...snapshot, selectedId: id }
      emit()
    },
    // Disk truth for one comet. A turn still in flight is not on disk yet,
    // so the pending pair stays on top of whatever was read.
    load(id: string, turns: ChatTurnDto[]): void {
      const current = thread(id)
      const tail = current.busy ? pendingTail(current.messages) : []
      patch(id, { messages: [...turns.map((turn) => ({ role: turn.role, text: turn.text })), ...tail] })
    },
    setDraft(id: string, draft: string): void {
      patch(id, { draft })
    },
    append(id: string, message: CometMessage): void {
      patch(id, { messages: [...thread(id).messages, message] })
    },
    clearOffer(id: string): void {
      patch(id, { offer: null })
    },
    forget(id: string): void {
      const rest = Object.fromEntries(Object.entries(snapshot.threads).filter(([key]) => key !== id))
      snapshot = { ...snapshot, threads: rest, selectedId: snapshot.selectedId === id ? null : snapshot.selectedId }
      emit()
    },
    // Takes the seat for a send and hands back the history to ship with it:
    // settled turns only, never a half answer or an error bubble.
    begin(id: string, message: string): ChatTurnDto[] {
      const current = thread(id)
      const history = current.messages
        .filter((m) => !m.streaming && !m.error)
        .map((m) => ({ role: m.role, text: m.text }))
      patch(id, {
        busy: true,
        adopted: false,
        stopped: false,
        startedAt: Date.now(),
        workLines: [],
        keptWork: [],
        offer: null,
        draft: '',
        messages: [...current.messages, { role: 'user', text: message }, { role: 'assistant', text: '', streaming: true }],
      })
      return history
    },
    // An answer main is still producing for this comet, started before this
    // renderer existed: hold a seat so its done event has somewhere to land.
    adopt(id: string): void {
      const current = thread(id)
      if (current.busy) return
      patch(id, {
        busy: true,
        adopted: true,
        stopped: false,
        startedAt: Date.now(),
        messages: [...current.messages, { role: 'assistant', text: '', streaming: true }],
      })
    },
    // A completion arrived for a thread that was not waiting: counted, so an
    // adopt in flight can tell that its seat is no longer needed.
    noteDone(id: string): void {
      patch(id, { doneSeen: thread(id).doneSeen + 1 })
    },
    // The abort's own done event has been and gone; the flag has done its job.
    clearStopped(id: string): void {
      if (thread(id).stopped) patch(id, { stopped: false })
    },
    fail,
    stop(id: string, fallback: string): void {
      settle(
        id,
        thread(id).messages.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || fallback } : m)),
        { stopped: true },
      )
    },
    // Feeds one main-process event to the thread it belongs to. Returns that
    // comet's id when the event was consumed here; null means nobody in this
    // store was waiting for it.
    handleEvent(event: EngramEvent): string | null {
      if (!('channel' in event)) return null
      const id = cometOfChannel(event.channel)
      if (!id) return null
      const current = thread(id)
      if (!current.busy) return null
      if (event.type === 'comet:step') {
        patch(id, { workLines: [...current.workLines.slice(1 - WORK_LINES_KEPT), event.line] })
        return id
      }
      if (event.type === 'chat:token') {
        const at = streamingAt(current.messages)
        if (at < 0) return id
        const next = [...current.messages]
        next[at] = { ...next[at]!, text: event.reset ? '' : next[at]!.text + event.text }
        patch(id, { messages: next })
        return id
      }
      if (event.type === 'chat:done') {
        const at = streamingAt(current.messages)
        const next = [...current.messages]
        if (at >= 0) next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false }
        settle(id, next, { offer: event.offer ?? null })
        return id
      }
      if (event.type === 'chat:error') {
        fail(id, event.message)
        return id
      }
      return null
    },
  }
}
