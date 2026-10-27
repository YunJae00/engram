import type { ChatAttachmentDto, EngramApi } from '../../../shared/types.js'
import { cometChannel, type CometThreadsStore } from './cometThreads.js'
import { threadLang, threadT } from './threadLang.js'

export function chatMessage(draft: string, attachments: ChatAttachmentDto[]): string {
  return [draft.trim(), attachments.length ? `Attached: ${attachments.map(one => one.name).join(', ')}` : ''].filter(Boolean).join('\n\n')
}

type ChatApi = Pick<EngramApi, 'chatSend' | 'onEvent'> & Partial<Pick<EngramApi, 'chatActive' | 'chatAbort' | 'chatSteer' | 'chatSay'>>
const active = new WeakMap<CometThreadsStore, Set<string>>()
const draining = new WeakMap<CometThreadsStore, Set<string>>()
const seats = (map: WeakMap<CometThreadsStore, Set<string>>, store: CometThreadsStore) => { let set = map.get(store); if (!set) { set = new Set(); map.set(store, set) } return set }

export async function flushQueuedCometMessages(api: ChatApi, store: CometThreadsStore, botId: string): Promise<void> {
  const current = store.thread(botId)
  if (current.busy || !current.queued.length || seats(active, store).has(botId) || seats(draining, store).has(botId)) return
  seats(draining, store).add(botId)
  let retry = false
  try {
    if (api.chatActive && (await api.chatActive()).includes(cometChannel(botId))) {
      retry = true
      return
    }
    if (store.thread(botId).busy) return
    const message = store.takeQueued(botId)
    if (message) await sendNow(api, store, botId, message.draft, message.attachments, true, message.shown)
  } catch { /* What could not start is not kept waiting out of sight. */ }
  finally { seats(draining, store).delete(botId); if (!store.thread(botId).busy && store.thread(botId).queued.length) setTimeout(() => void flushQueuedCometMessages(api, store, botId), retry ? 500 : 0) }
}

// Nothing waits in a queue the person can see. Said while a comet works, the
// words show at once at the foot of the conversation and the voice answers
// them; whatever is for after this turn starts by itself when it ends.
export async function sendCometMessage(api: ChatApi, store: CometThreadsStore, botId: string, draft: string, attachments: ChatAttachmentDto[] = []): Promise<void> {
  if (!chatMessage(draft, attachments)) return
  if (store.thread(botId).busy) {
    const stopCount = store.thread(botId).stopCount
    const said = chatMessage(draft, attachments)
    const words = threadT(threadLang(store.thread(botId).messages))
    store.noteWork(botId, `you: ${said}`)
    // The words left the box; anything typed since stays.
    if (store.thread(botId).draft === draft) store.setDraft(botId, '')
    // Files cannot join a turn already under way: they start the next one.
    if (attachments.length || !api.chatSay) {
      if (attachments.length) store.setAttachments(botId, [])
      store.noteWork(botId, `said: ${words('aside.next')}`)
      store.enqueue(botId, draft, attachments, true)
      return
    }
    const answer = await api.chatSay(cometChannel(botId), draft.trim()).catch(() => ({ ok: false as const }))
    if (store.thread(botId).stopCount !== stopCount) return
    if (!answer.ok) {
      store.noteWork(botId, `said: ${words('aside.next')}`)
      store.enqueue(botId, draft, [], true)
      void flushQueuedCometMessages(api, store, botId)
      return
    }
    // A stop is said where the work ends; anything else in the running work.
    if (answer.action === 'stop' && store.thread(botId).busy) { store.stop(botId, answer.reply ?? ''); await api.chatAbort?.(cometChannel(botId)).catch(() => undefined); return }
    store.noteWork(botId, `said: ${answer.reply || words('aside.passed')}`)
    if (answer.action === 'later' && answer.instruction) store.enqueue(botId, answer.instruction, [], true)
    void flushQueuedCometMessages(api, store, botId)
    return
  }
  // Sent again before the first one took its seat: it goes right after, shown when it starts.
  if (store.thread(botId).queued.length || seats(active, store).has(botId) || seats(draining, store).has(botId)) {
    store.enqueue(botId, draft, attachments)
    void flushQueuedCometMessages(api, store, botId)
    return
  }
  await sendNow(api, store, botId, draft, attachments)
}

// A message that failed is sent again where it stood, as if just written.
export async function resendFailedCometMessage(api: ChatApi, store: CometThreadsStore, botId: string): Promise<void> {
  const failed = store.takeFailed(botId)
  if (failed) await sendCometMessage(api, store, botId, failed.text)
}

async function sendNow(api: ChatApi, store: CometThreadsStore, botId: string, draft: string, attachments: ChatAttachmentDto[], queued = false, shown = false): Promise<void> {
  const message = chatMessage(draft, attachments)
  seats(active, store).add(botId)
  const ids = attachments.map(one => one.id)
  const nextDraft = store.thread(botId).draft
  const nextFiles = store.thread(botId).attachments
  const history = store.begin(botId, message, ids, false, shown)
  if (queued) { store.setDraft(botId, nextDraft); store.setAttachments(botId, nextFiles) }
  let settled = false
  const fail = (reason: string) => {
    if (settled) return
    settled = true
    if (store.thread(botId).busy) store.fail(botId, reason)
    if (!store.thread(botId).draft && !store.thread(botId).attachments.length) { store.setDraft(botId, draft); store.setAttachments(botId, attachments) }
  }
  const channel = cometChannel(botId)
  const unsubscribe = api.onEvent(event => {
    if (event.type === 'chat:done' && event.channel === channel) settled = true
    else if (event.type === 'chat:error' && event.channel === channel) fail(event.message)
  })
  try {
    await api.chatSend({ engineId: '', message, history, attachments: ids, channel, botId })
  } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)) }
  finally { unsubscribe(); seats(active, store).delete(botId); void flushQueuedCometMessages(api, store, botId) }
}
