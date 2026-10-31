import type { ChatAttachmentDto, ChatTurnDto, EngramEvent } from '../../../shared/types.js'


export interface CometMessage extends ChatTurnDto {
  streaming?: boolean
  error?: boolean
  errorKind?: string
  provider?: string
  checking?: boolean
  work?: string[]
}

export function withWork(messages: CometMessage[], work: string[]): CometMessage[] {
  if (!work.length) return messages
  const at = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1)
  if (at < 0 || messages[at]!.work) return messages
  return messages.map((message, index) => index === at ? { ...message, work } : message)
}

export type CometOffer = NonNullable<Extract<EngramEvent, { type: 'chat:done' }>['offer']>

export interface CometThread {
  unapplied: string[]
  queued: { id: string; draft: string; attachments: ChatAttachmentDto[]; shown?: boolean }[]
  messages: CometMessage[]
  loaded: boolean
  busy: boolean
  taskWorking?: boolean
  awaitingModel?: boolean
  workLines: string[]
  keptWork: string[]
  offer: CometOffer | null
  draft: string
  attachments: ChatAttachmentDto[]
  adopted: boolean
  stopped: boolean
  stopCount?: number
  startedAt: number | null
  doneSeen: number
}

export interface CometThreadsSnapshot {
  selectedId: string | null
  threads: Readonly<Record<string, CometThread>>
}

export type CometThreadsStore = ReturnType<typeof createCometThreads>

const EMPTY: CometThread = { unapplied: [], queued: [], messages: [], loaded: false, busy: false, workLines: [], keptWork: [], offer: null, draft: '', attachments: [], adopted: false, stopped: false, startedAt: null, doneSeen: 0 }
const CHANNEL_PREFIX = 'bot-'
const WORK_LINES_KEPT = 64

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

function pendingTail(list: CometMessage[]): CometMessage[] {
  const at = streamingAt(list)
  if (at < 0) return []
  const before = list[at - 1]
  return before && before.role === 'user' ? list.slice(at - 1) : list.slice(at)
}

export function createCometThreads(initialSelected: string | null = null) {
  let snapshot: CometThreadsSnapshot = { selectedId: initialSelected, threads: {} }
  let queueSerial = 0
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const soon = (run: () => void): number => setTimeout(run, 80) as unknown as number
  const cancel = (handle: number): void => clearTimeout(handle)
  let framed = 0
  const emitSoon = () => {
    if (framed) return
    framed = soon(() => {
      framed = 0
      emit()
    })
  }
  const thread = (id: string | null): CometThread => (id ? (snapshot.threads[id] ?? EMPTY) : EMPTY)
  const patch = (id: string, next: Partial<CometThread>, soon = false) => {
    snapshot = { ...snapshot, threads: { ...snapshot.threads, [id]: { ...thread(id), ...next } } }
    if (soon) emitSoon()
    else {
      if (framed) {
        cancel(framed)
        framed = 0
      }
      emit()
    }
  }
  const settle = (id: string, messages: CometMessage[], extra: Partial<CometThread> = {}) =>
    patch(id, { busy: !!thread(id).taskWorking, adopted: false, workLines: [], keptWork: thread(id).workLines, startedAt: thread(id).taskWorking ? thread(id).startedAt : null, messages: withWork(messages, thread(id).workLines), doneSeen: thread(id).doneSeen + 1, ...extra })
  const fail = (id: string, text: string, kind?: string, provider?: string) => {
    const kept = thread(id).messages.filter((m) => !(m.role === 'assistant' && m.streaming))
    const earlier = kept.at(-1)?.error ? kept.at(-1)! : undefined
    const said: CometMessage = { role: 'assistant', text: text || earlier?.text || '', error: true, ...(kind ?? earlier?.errorKind ? { errorKind: kind ?? earlier?.errorKind } : {}), ...(provider ?? earlier?.provider ? { provider: provider ?? earlier?.provider } : {}) }
    settle(id, [...(earlier ? kept.slice(0, -1) : kept), said], { queued: [] })
  }

  const draftListeners = new Set<() => void>()
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeDraft(listener: () => void): () => void {
      draftListeners.add(listener)
      return () => { draftListeners.delete(listener) }
    },
    getSnapshot: (): CometThreadsSnapshot => snapshot,
    thread,
    enqueue(id: string, draft: string, attachments: ChatAttachmentDto[] = [], shown = false): boolean {
      const current = thread(id)
      patch(id, { queued: [...current.queued, { id: `q-${Date.now()}-${++queueSerial}`, draft, attachments: [...attachments], ...(shown ? { shown } : {}) }], ...(!shown ? { draft: '', attachments: [] } : {}) })
      return true
    },
    takeQueued(id: string): CometThread['queued'][number] | undefined {
      const current = thread(id)
      const first = current.queued[0]
      if (first) patch(id, { queued: current.queued.slice(1) })
      return first
    },
    anyBusy: (): boolean => Object.values(snapshot.threads).some((one) => one.busy),
    select(id: string | null): void {
      if (id === snapshot.selectedId) return
      snapshot = { ...snapshot, selectedId: id }
      emit()
    },
    fresh(id: string): void {
      patch(id, { ...EMPTY, loaded: true })
    },
    load(id: string, turns: ChatTurnDto[], seenDone?: number): void {
      const current = thread(id)
      if (seenDone !== undefined && seenDone !== current.doneSeen) return
      const tail = current.busy ? pendingTail(current.messages) : []
      const last = turns.at(-1)
      const asked: string[] = []
      for (let at = turns.length - 2; at >= 0 && turns[at]!.role === 'user'; at--) asked.push(turns[at]!.text)
      if (tail[0]?.role === 'user' && last?.role === 'assistant' && asked.includes(tail[0].text) && turns.length >= current.messages.length) tail.length = 0
      else if (tail[0]?.role === 'user' && last?.role === 'user' && tail[0].text === last.text) tail.shift()
      patch(id, { messages: [...turns.map((turn) => ({ role: turn.role, text: turn.text, ...(turn.attachments?.length ? { attachments: turn.attachments } : {}), ...(turn.scheduled ? { scheduled: true } : {}) })), ...tail], loaded: true })
    },
    setDraft(id: string, draft: string): void {
      const current = thread(id)
      if (current.draft === draft) return
      snapshot = { ...snapshot, threads: { ...snapshot.threads, [id]: { ...current, draft } } }
      for (const listener of draftListeners) listener()
    },
    setAttachments(id: string, attachments: ChatAttachmentDto[]): void {
      patch(id, { attachments })
    },
    append(id: string, message: CometMessage): void {
      patch(id, { messages: [...thread(id).messages, message] })
    },
    clearUnapplied(id: string, text: string): void { patch(id, { unapplied: thread(id).unapplied.filter(one => one !== text) }) },
    clearOffer(id: string): void {
      patch(id, { offer: null })
    },
    forget(id: string): void {
      const rest = Object.fromEntries(Object.entries(snapshot.threads).filter(([key]) => key !== id))
      snapshot = { ...snapshot, threads: rest, selectedId: snapshot.selectedId === id ? null : snapshot.selectedId }
      emit()
    },
    begin(id: string, message: string, attachments: string[] = [], scheduled = false, alreadyShown = false): ChatTurnDto[] {
      const current = thread(id)
      const history = current.messages
        .filter((m) => !m.streaming && !m.error)
        .map((m) => ({ role: m.role, text: m.text, ...(m.attachments?.length ? { attachments: m.attachments } : {}) }))
      patch(id, {
        busy: true,
        awaitingModel: false,
        adopted: false,
        stopped: false,
        startedAt: Date.now(),
        workLines: [],
        keptWork: [],
        offer: null,
        ...(scheduled ? {} : { draft: '', attachments: [] }),
        messages: [...current.messages, ...(alreadyShown ? [] : [{ role: 'user' as const, text: message, ...(attachments.length ? { attachments } : {}), ...(scheduled ? { scheduled: true } : {}) }]), { role: 'assistant', text: '', streaming: true }],
      })
      return history
    },
    carryOn(id: string): void {
      const current = thread(id)
      if (streamingAt(current.messages) >= 0) return
      patch(id, { busy: true, awaitingModel: false, adopted: false, stopped: false, startedAt: Date.now(), workLines: [], keptWork: [], offer: null, messages: [...current.messages, { role: 'assistant', text: '', streaming: true }] })
    },
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
    noteDone(id: string): void {
      patch(id, { doneSeen: thread(id).doneSeen + 1 })
    },
    clearStopped(id: string): void {
      if (thread(id).stopped) patch(id, { stopped: false })
    },
    fail,
    takeFailed(id: string): { text: string; attachments: string[] } | null {
      const messages = thread(id).messages
      const failed = messages.at(-1), asked = messages.at(-2)
      if (thread(id).busy || !failed?.error || asked?.role !== 'user') return null
      patch(id, { messages: messages.slice(0, -2) })
      return { text: asked.text, attachments: asked.attachments ?? [] }
    },
    noteWork(id: string, line: string): void {
      const current = thread(id)
      if (!current.busy) return
      patch(id, { workLines: [...current.workLines.slice(1 - WORK_LINES_KEPT), line] })
    },
    stop(id: string, fallback: string): void {
      settle(
        id,
        thread(id).messages.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || fallback } : m)),
        { stopped: true, stopCount: (thread(id).stopCount ?? 0) + 1, queued: [] },
      )
    },
    handleEvent(event: EngramEvent): string | null {
      if (!('channel' in event) || !event.channel) return null
      const id = cometOfChannel(event.channel)
      if (!id) return null
      const current = thread(id)
      if (event.type === 'comet:working') {
        patch(id, {
          taskWorking: event.working, busy: event.working,
          startedAt: event.working ? current.startedAt ?? Date.now() : null,
          doneSeen: current.doneSeen + 1,
          ...(event.working && !current.busy ? { adopted: true, messages: [...current.messages, { role: 'assistant' as const, text: '', streaming: true }] } : {}),
          ...(!event.working ? { workLines: [], keptWork: current.workLines.length ? current.workLines : current.keptWork, messages: withWork(current.messages.filter(m => !m.streaming || (m.text && !m.checking)).map(m => ({ ...m, streaming: false })), current.workLines) } : {}),
        })
        return id
      }
      if (event.type === 'chat:offer') {
        if (current.busy || current.stopped) return null
        patch(id, { offer: event.offer })
        return id
      }
      if (!current.busy) return null
      if (event.type === 'comet:observed') {
        patch(id, { awaitingModel: true })
        return id
      }
      if (event.type === 'comet:step') {
        patch(id, { awaitingModel: false, workLines: [...current.workLines.slice(1 - WORK_LINES_KEPT), event.line] }, true)
        return id
      }
      if (event.type === 'chat:token') {
        const at = streamingAt(current.messages)
        if (at < 0) return id
        const next = [...current.messages]
        if (event.reset) {
          if (event.drop) {
            if (next[at]!.text.trim()) { next[at] = { ...next[at]!, checking: true }; patch(id, { messages: next }, true) }
            return id
          }
          const said = next[at]!.text.trim()
          next[at] = { ...next[at]!, text: '' }
          const lines = said ? [...current.workLines.slice(1 - WORK_LINES_KEPT), `said: ${said}`] : current.workLines
          patch(id, { messages: next, workLines: lines }, true)
          return id
        }
        next[at] = next[at]!.checking ? { ...next[at]!, text: event.text, checking: undefined } : { ...next[at]!, text: next[at]!.text + event.text }
        patch(id, { messages: next }, true)
        return id
      }
      if (event.type === 'chat:done') {
        const at = streamingAt(current.messages)
        const next = [...current.messages]
        if (at >= 0) next[at] = { ...next[at]!, text: event.text || next[at]!.text, streaming: false, checking: undefined, ...(event.evidence ? { evidence: event.evidence } : {}) }
        settle(id, next, { offer: event.offer ?? null })
        return id
      }
      if (event.type === 'chat:error') {
        fail(id, event.message, event.kind, event.provider)
        return id
      }
      return null
    },
  }
}
