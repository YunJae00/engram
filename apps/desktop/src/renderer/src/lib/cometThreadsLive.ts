import { api } from '../api.js'
import { cometChannel, cometOfChannel, createCometThreads } from './cometThreads.js'
import { webPane } from './webPane.js'
import { flushQueuedCometMessages } from './attachments.js'

const SELECTED_KEY = 'engram.comets.selected'

const LAUNCHED_KEY = 'engram.comets.launched'
const stored = typeof sessionStorage !== 'undefined' && typeof localStorage !== 'undefined'
const fresh = stored && sessionStorage.getItem(LAUNCHED_KEY) === null
if (stored) sessionStorage.setItem(LAUNCHED_KEY, '1')
export const cometThreads = createCometThreads(fresh ? localStorage.getItem(SELECTED_KEY) : null)
const pendingReloads = new Set<string>()

export function selectComet(id: string | null): void {
  cometThreads.select(id)
  if (id) localStorage.setItem(SELECTED_KEY, id)
  else localStorage.removeItem(SELECTED_KEY)
}

const reloadFromDisk = (id: string) => {
  const seenBefore = cometThreads.thread(id).doneSeen
  return api
    .botTranscript(id)
    .then((turns) => cometThreads.load(id, turns, seenBefore))
    .catch(() => undefined)
}

export const loadEarlierTurns = (id: string, beforeCommit?: () => void) =>
  cometThreads.loadEarlier(id, (bot, before, limit) => api.botTranscriptPage(bot, before, limit), beforeCommit)

export async function loadCometThread(id: string): Promise<void> {
  const seenBefore = cometThreads.thread(id).doneSeen
  const turns = await api.botTranscript(id)
  cometThreads.load(id, turns, seenBefore)
  const active = await api.chatActive().catch(() => [] as string[])
  const tasks = await api.tasksList().catch(() => [])
  if (!cometThreads.thread(id).stopped && active.includes(cometChannel(id)) && cometThreads.thread(id).doneSeen === seenBefore) {
    cometThreads.adopt(id)
    if (tasks.some(task => task.botId === id && ['running', 'queued'].includes(task.state)))
      cometThreads.handleEvent({ type: 'comet:working', channel: cometChannel(id), working: true })
  }
  void flushQueuedCometMessages(api, cometThreads, id)
}

api.onEvent((event) => {
  if (event.type === 'comet:quick') {
    const { draft, attachments } = cometThreads.thread(event.botId)
    cometThreads.begin(event.botId, event.message, event.attachments)
    cometThreads.setDraft(event.botId, draft)
    cometThreads.setAttachments(event.botId, attachments)
    return
  }
  if (event.type === 'comet:scheduled') {
    cometThreads.begin(event.botId, event.message, [], true)
    return
  }
  if (event.type === 'comet:continue') {
    cometThreads.carryOn(event.botId)
    return
  }
  if (event.type === 'routine:chat') {
    cometThreads.fresh(event.botId)
    cometThreads.begin(event.botId, event.message)
    return
  }
  webPane.handleEvent(event)
  const adoptedBefore = 'channel' in event && event.channel ? cometThreads.thread(cometOfChannel(event.channel)).adopted : false
  const handled = cometThreads.handleEvent(event)
  if (handled) {
    if (event.type === 'chat:done' && adoptedBefore) {
      if (cometThreads.thread(handled).taskWorking) pendingReloads.add(handled)
      void reloadFromDisk(handled).then(() => flushQueuedCometMessages(api, cometThreads, handled))
    }
    if (event.type === 'comet:working' && !event.working && pendingReloads.delete(handled) && !cometThreads.thread(handled).stopped)
      void reloadFromDisk(handled).then(() => flushQueuedCometMessages(api, cometThreads, handled))
    else if ((event.type === 'chat:done' && !adoptedBefore) || (event.type === 'comet:working' && !event.working))
      void flushQueuedCometMessages(api, cometThreads, handled)
    return
  }
  if (event.type === 'errand:logged') {
    const id = cometThreads.getSnapshot().selectedId
    if (id) void reloadFromDisk(id)
    return
  }
  if (event.type === 'chat:done' || event.type === 'chat:error') {
    const id = cometOfChannel(event.channel)
    if (!id || !cometThreads.getSnapshot().threads[id]) return
    cometThreads.noteDone(id)
    if (cometThreads.thread(id).stopped) {
      return
    }
    void reloadFromDisk(id)
  }
})
