import type { ChatAttachmentDto, EngramApi } from '../../../shared/types.js'
import { cometChannel, type CometThreadsStore } from './cometThreads.js'

export function chatMessage(draft: string, attachments: ChatAttachmentDto[]): string {
  return [draft.trim(), attachments.length ? `Attached: ${attachments.map(one => one.name).join(', ')}` : ''].filter(Boolean).join('\n\n')
}

type ChatApi = Pick<EngramApi, 'chatSend' | 'onEvent'> & Partial<Pick<EngramApi, 'chatActive' | 'chatAbort' | 'chatSteer' | 'chatSay'>>
const active = new WeakMap<CometThreadsStore, Set<string>>()
const draining = new WeakMap<CometThreadsStore, Set<string>>()
const seats = (map: WeakMap<CometThreadsStore, Set<string>>, store: CometThreadsStore) => { let set = map.get(store); if (!set) { set = new Set(); map.set(store, set) } return set }

export async function flushQueuedCometMessages(api: ChatApi, store: CometThreadsStore, botId: string): Promise<void> {
  const current = store.thread(botId)
  if (current.busy || current.queueHeld || !current.queued.length || seats(active, store).has(botId) || seats(draining, store).has(botId)) return
  seats(draining, store).add(botId)
  let retry = false
  try {
    if (api.chatActive && (await api.chatActive()).includes(cometChannel(botId))) {
      retry = true
      return
    }
    if (store.thread(botId).busy || store.thread(botId).queueHeld) return
    const message = store.takeQueued(botId)
    if (message) await sendNow(api, store, botId, message.draft, message.attachments, true)
  } catch { store.restoreQueue(botId, store.thread(botId).queued) }
  finally { seats(draining, store).delete(botId); if (!store.thread(botId).busy && !store.thread(botId).queueHeld && store.thread(botId).queued.length) setTimeout(() => void flushQueuedCometMessages(api, store, botId), retry ? 500 : 0) }
}

export async function sendCometMessage(api: ChatApi, store: CometThreadsStore, botId: string, draft: string, attachments: ChatAttachmentDto[] = []): Promise<void> {
  if (!chatMessage(draft, attachments)) return
  if (store.thread(botId).busy || store.thread(botId).queued.length || seats(active, store).has(botId) || seats(draining, store).has(botId)) {
    // Words for the work in progress join it at its next step; files, and words with nothing running to take them, wait their turn.
    // Said while the work runs: it shows at once and is answered at once,
    // and the answer decides what it means for the work.
    if (store.thread(botId).busy && !attachments.length && api.chatSay) {
      const said = draft.trim()
      store.aside(botId, 'user', said)
      // The words left the box; anything typed since stays.
      if (store.thread(botId).draft === draft) store.setDraft(botId, '')
      const answer = await api.chatSay(cometChannel(botId), said).catch(() => ({ ok: false as const }))
      if (answer.ok) {
        // A stop is said where the work ends; anything else above the running work.
        if (answer.action === 'stop' && store.thread(botId).busy) { store.stop(botId, answer.reply ?? ''); await api.chatAbort?.(cometChannel(botId)).catch(() => undefined) }
        else if (answer.reply) store.aside(botId, 'assistant', answer.reply)
        if (answer.action === 'later' && answer.instruction && store.enqueue(botId, answer.instruction)) void flushQueuedCometMessages(api, store, botId)
        return
      }
      if (store.enqueue(botId, said, attachments)) void flushQueuedCometMessages(api, store, botId)
      return
    }
    if (store.enqueue(botId, draft, attachments)) void flushQueuedCometMessages(api, store, botId)
    return
  }
  await sendNow(api, store, botId, draft, attachments)
}

async function sendNow(api: ChatApi, store: CometThreadsStore, botId: string, draft: string, attachments: ChatAttachmentDto[], queued = false): Promise<void> {
  const message = chatMessage(draft, attachments)
  seats(active, store).add(botId)
  const ids = attachments.map(one => one.id)
  const nextDraft = store.thread(botId).draft
  const nextFiles = store.thread(botId).attachments
  const history = store.begin(botId, message, ids)
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

// Send a waiting message now: the reply in progress stops where it is, keeps
// what it already said in the thread, and the chosen message goes next - the
// way a person cuts in on a colleague instead of waiting for them to finish.
export async function sendQueuedNow(api: ChatApi, store: CometThreadsStore, botId: string, key: string, stopped: string): Promise<void> {
  store.promoteQueued(botId, key)
  if (store.thread(botId).busy) {
    store.stop(botId, stopped)
    await api.chatAbort?.(cometChannel(botId)).catch(() => undefined)
  }
  store.resumeQueue(botId)
  await flushQueuedCometMessages(api, store, botId)
}
