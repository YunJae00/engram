import type { ChatAttachmentDto, ChatTurnDto, EngramEvent } from '../../../shared/types.js'
import { doneText, liveTail } from './answerTail.js'
import { shownTexts } from './transcriptOrder.js'

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
  streamPrefix?: string; streamTail?: string
  stopCount?: number
  startedAt: number | null
  doneSeen: number
  // Paging: key offset of prepended messages, raw disk turns represented, the last read's identities,
  // every represented raw turn oldest first, and newer turns a page already saw before the next read.
  older: number; cursor: number; pageDone: boolean; pageLoading: boolean
  window: string[]; coverage: string[]; unseenAppend: number
}

export interface CometThreadsSnapshot {
  selectedId: string | null
  threads: Readonly<Record<string, CometThread>>
}

export type CometThreadsStore = ReturnType<typeof createCometThreads>

const EMPTY: CometThread = { unapplied: [], queued: [], messages: [], loaded: false, busy: false, workLines: [], keptWork: [], offer: null, draft: '', attachments: [], adopted: false, stopped: false, startedAt: null, doneSeen: 0, older: 0, cursor: 0, pageDone: false, pageLoading: false, window: [], coverage: [], unseenAppend: 0 }
const CHANNEL_PREFIX = 'bot-'
const WORK_LINES_KEPT = 64
const TRANSCRIPT_CAP = 400
export const PAGE_SIZE = 100

type PageRead = (id: string, before: number, limit: number) => Promise<ChatTurnDto[]>

const identity = (turn: { role: string; at?: string; text: string }): string => `${turn.role}\n${turn.at ?? ''}\n${turn.text}`

const toMessage = (turn: ChatTurnDto): CometMessage => ({ role: turn.role, text: turn.text, ...(turn.at ? { at: turn.at } : {}), ...(turn.attachments?.length ? { attachments: turn.attachments } : {}), ...(turn.scheduled ? { scheduled: true } : {}), ...(turn.progress ? { progress: true } : {}), ...(turn.work ? { work: turn.work } : {}), ...(turn.evidence ? { evidence: turn.evidence } : {}) })

// Where `next` starts inside `coverage` so their overlap runs to the end of `coverage`, or -1.
function alignAt(coverage: string[], next: string[]): number {
  for (let start = 0; start < coverage.length; start++) {
    let same = coverage[start] === next[0]
    for (let i = 1; start + i < coverage.length && i < next.length && same; i++) same = coverage[start + i] === next[i]
    if (same) return start
  }
  return -1
}

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
  let pageSerial = 0
  const pageTokens = new Map<string, number>()
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
    patch(id, { busy: !!thread(id).taskWorking, adopted: false, workLines: [], keptWork: thread(id).workLines, startedAt: thread(id).taskWorking ? thread(id).startedAt : null, messages: withWork(messages, thread(id).workLines), doneSeen: thread(id).doneSeen + 1, streamPrefix: '', streamTail: '', ...extra })
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
      pageTokens.delete(id)
      patch(id, { ...EMPTY, loaded: true, pageDone: true, doneSeen: thread(id).doneSeen + 1 })
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
      const window: string[] = [], fromDisk: CometMessage[] = []
      let firstShown: string | undefined
      const said = shownTexts(turns)
      for (let at = 0; at < turns.length; at++) {
        window.push(identity(turns[at]!))
        if (said[at] !== null) { fromDisk.push({ ...toMessage(turns[at]!), text: said[at]! }); firstShown ??= window[at] }
      }
      // Raw overlap proves continuity; the first shown new turn marks where the kept messages end.
      const start = current.older > 0 && window.length ? alignAt(current.coverage, window) : -1
      const keep = start >= 0 && firstShown !== undefined ? current.messages.findIndex((message, at) => at >= current.older && identity(message) === firstShown) : -1
      const arrived = window.length - (current.coverage.length - start)
      const paging: Partial<CometThread> = keep >= 0
        ? { cursor: current.cursor + Math.max(0, arrived - current.unseenAppend), coverage: [...current.coverage.slice(0, start), ...window], unseenAppend: 0 }
        : { older: 0, cursor: turns.length, pageDone: turns.length < TRANSCRIPT_CAP, coverage: window, unseenAppend: 0 }
      if (paging.cursor !== current.cursor || window.length !== current.window.length || window.some((one, at) => one !== current.window[at])) {
        pageTokens.delete(id)
        paging.pageLoading = false
      }
      patch(id, { messages: [...(keep >= 0 ? current.messages.slice(0, keep) : []), ...fromDisk, ...tail], loaded: true, window, ...paging })
    },
    // Reads the page of disk turns just older than what the thread holds and puts it in front, once per call.
    async loadEarlier(id: string, read: PageRead, beforeCommit?: () => void): Promise<number> {
      const start = thread(id)
      if (!snapshot.threads[id] || !start.loaded || start.pageDone || start.pageLoading) return 0
      const token = ++pageSerial, before = start.cursor
      pageTokens.set(id, token)
      patch(id, { pageLoading: true })
      const page = await read(id, before, PAGE_SIZE).catch(() => null)
      if (!page) { if (pageTokens.get(id) === token && pageTokens.delete(id)) patch(id, { pageLoading: false }); return 0 }
      const current = thread(id)
      if (!snapshot.threads[id] || pageTokens.get(id) !== token || current.cursor !== before) return 0
      pageTokens.delete(id)
      // Turns appended on disk after the cursor was read shift the page newer; its tail then overlaps coverage.
      const overlap = page.length ? current.coverage.indexOf(identity(page[page.length - 1]!)) + 1 : 0
      let fits = overlap <= page.length
      for (let at = 0; at < overlap && fits; at++) fits = identity(page[page.length - overlap + at]!) === current.coverage[at]
      if (!fits) { patch(id, { pageLoading: false }); return 0 }
      const had = new Set(current.messages.map(identity))
      const combined: ChatTurnDto[] = [...page, ...current.messages]
      const added: CometMessage[] = [], seen: string[] = []
      const said = shownTexts(combined)
      for (let at = 0; at < page.length; at++) {
        const key = identity(page[at]!)
        if (at < page.length - overlap) seen.push(key)
        if (at < page.length - overlap && !had.has(key) && said[at] !== null) { had.add(key); added.push({ ...toMessage(page[at]!), text: said[at]! }) }
      }
      if (added.length) beforeCommit?.()
      patch(id, { messages: [...added, ...current.messages], older: current.older + added.length, cursor: before + page.length, pageDone: page.length < PAGE_SIZE, pageLoading: false, coverage: [...seen, ...current.coverage], unseenAppend: current.unseenAppend + overlap })
      return added.length
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
      pageTokens.delete(id)
      const rest = Object.fromEntries(Object.entries(snapshot.threads).filter(([key]) => key !== id))
      snapshot = { ...snapshot, threads: rest, selectedId: snapshot.selectedId === id ? null : snapshot.selectedId }
      emit()
    },
    begin(id: string, message: string, attachments: string[] = [], scheduled = false, alreadyShown = false): ChatTurnDto[] {
      const current = thread(id)
      const history = current.messages
        .filter((m) => !m.streaming && !m.error && !m.progress)
        .map((m) => ({ role: m.role, text: m.text, ...(m.attachments?.length ? { attachments: m.attachments } : {}) }))
      patch(id, {
        busy: true,
        awaitingModel: false,
        adopted: false,
        stopped: false,
        streamPrefix: '', streamTail: '',
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
    fail,
    takeFailed(id: string): { text: string; attachments: string[] } | null {
      const messages = thread(id).messages
      const failed = messages.at(-1), asked = messages.at(-2)
      if (thread(id).busy || !failed?.error || asked?.role !== 'user') return null
      patch(id, { messages: messages.slice(0, -2) })
      return { text: asked.text, attachments: asked.attachments ?? [] }
    },
    noteUser(id: string, text: string, attachments: string[] = []): void {
      const current = thread(id)
      const at = streamingAt(current.messages)
      const messages = [...current.messages]
      const partial = at >= 0 ? messages[at]!.text : ''
      if (at >= 0) {
        if (partial) messages[at] = { ...messages[at]!, streaming: false, progress: true, work: current.workLines }
        else messages.splice(at, 1)
      }
      messages.push({ role: 'user', text, ...(attachments.length ? { attachments } : {}) })
      if (current.busy) messages.push({ role: 'assistant', text: '', streaming: true })
      patch(id, { messages, streamPrefix: (current.streamPrefix ?? '') + (current.streamPrefix ? current.streamTail ?? '' : partial), streamTail: '', ...(partial ? { workLines: [] } : {}) })
    },
    noteWork(id: string, line: string): void {
      const current = thread(id)
      if (!current.busy) return
      patch(id, { workLines: [...current.workLines.slice(1 - WORK_LINES_KEPT), line] })
    },
    stop(id: string, fallback: string, marker?: string): string {
      const current = thread(id), at = streamingAt(current.messages)
      const cut = !!marker && at >= 0 && !!current.messages[at]!.text.trim()
      settle(
        id,
        cut
          ? [...current.messages.slice(0, at), { ...current.messages[at]!, streaming: false, checking: undefined, progress: true, work: current.workLines }, { role: 'assistant' as const, text: marker!, work: [] }, ...current.messages.slice(at + 1)]
          : current.messages.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false, text: m.text || fallback } : m)),
        { busy: false, taskWorking: false, awaitingModel: false, startedAt: null, stopped: true, stopCount: (current.stopCount ?? 0) + 1, queued: [] },
      )
      return cut ? marker! : fallback
    },
    handleEvent(event: EngramEvent): string | null {
      if (!('channel' in event) || !event.channel) return null
      const id = cometOfChannel(event.channel)
      if (!id) return null
      const current = thread(id)
      if (event.type === 'comet:working') {
        if (current.stopped && event.working) return id
        patch(id, {
          taskWorking: event.working, busy: event.working,
          startedAt: event.working ? current.startedAt ?? Date.now() : null,
          doneSeen: current.doneSeen + 1,
          ...(event.working && !current.busy ? { adopted: true, messages: [...current.messages, { role: 'assistant' as const, text: '', streaming: true }] } : {}),
          ...(!event.working ? { streamPrefix: '', streamTail: '', workLines: [], keptWork: current.workLines.length ? current.workLines : current.keptWork, messages: withWork(current.messages.filter(m => !m.streaming || (m.text && !m.checking)).map(m => ({ ...m, streaming: false })), current.workLines) } : {}),
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
          if (next[at]!.text.trim()) {
            next[at] = { ...next[at]!, streaming: false, progress: true, work: current.workLines }
            next.push({ role: 'assistant', text: '', streaming: true })
          }
          patch(id, { messages: next, streamPrefix: '', workLines: next.length > current.messages.length ? [] : current.workLines }, true)
          return id
        }
        const raw = current.streamPrefix && !next[at]!.checking ? (current.streamTail ?? '') + event.text : null
        next[at] = next[at]!.checking ? { ...next[at]!, text: event.text, checking: undefined } : { ...next[at]!, text: raw === null ? next[at]!.text + event.text : liveTail(current.streamPrefix ?? '', raw) }
        patch(id, { messages: next, ...(raw === null ? {} : { streamTail: raw }) }, true)
        return id
      }
      if (event.type === 'chat:done') {
        const at = streamingAt(current.messages), next = [...current.messages], text = at < 0 ? null : doneText(event.text, current.streamPrefix, next[at]!.text)
        if (at >= 0) next.splice(at, 1, ...(text === null ? [] : [{ ...next[at]!, text, streaming: false, checking: undefined, ...(event.evidence ? { evidence: event.evidence } : {}) }]))
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
