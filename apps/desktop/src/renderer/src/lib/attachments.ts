import type { ChatAttachmentDto, EngramApi } from '../../../shared/types.js'
import { cometChannel, type CometThreadsStore } from './cometThreads.js'

export function chatMessage(draft: string, attachments: ChatAttachmentDto[]): string {
  return [draft.trim(), attachments.length ? `Attached: ${attachments.map(one => one.name).join(', ')}` : ''].filter(Boolean).join('\n\n')
}

export async function sendCometMessage(api: Pick<EngramApi, 'chatSend' | 'onEvent'>, store: CometThreadsStore, botId: string, draft: string, attachments: ChatAttachmentDto[] = []): Promise<void> {
  const message = chatMessage(draft, attachments)
  if (!message || store.thread(botId).busy) return
  const ids = attachments.map(one => one.id)
  const history = store.begin(botId, message, ids)
  let failed = false
  const fail = (reason: string) => {
    if (failed) return
    failed = true
    if (store.thread(botId).busy) store.fail(botId, reason)
    if (!store.thread(botId).draft) store.setDraft(botId, draft)
    if (!store.thread(botId).attachments.length) store.setAttachments(botId, attachments)
  }
  const channel = cometChannel(botId)
  const unsubscribe = api.onEvent(event => { if (event.type === 'chat:error' && event.channel === channel) fail(event.message) })
  try {
    await api.chatSend({ engineId: '', message, history, attachments: ids, channel, botId })
  } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)) }
  finally { unsubscribe() }
}
