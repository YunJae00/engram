import type { CometThread, CometThreadsStore } from './cometThreads.js'

const prefix = 'engram.comets.queue.'
export function readQueued(storage: Pick<Storage, 'getItem'>, id: string): CometThread['queued'] {
  try {
    const value: unknown = JSON.parse(storage.getItem(prefix + id) || '[]')
    if (!Array.isArray(value) || value.length > 10) return []
    return value.filter(message => message && typeof message.id === 'string' && typeof message.draft === 'string' && message.draft.length <= 2000 && Array.isArray(message.attachments) && message.attachments.length <= 8 && message.attachments.every((file: { id?: unknown; name?: unknown; size?: unknown }) => file && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.size === 'number' && file.size > 0 && file.size <= 20 * 1024 * 1024))
  } catch { return [] }
}

export function persistQueues(store: CometThreadsStore, storage: Pick<Storage, 'setItem' | 'removeItem'>): () => void {
  const saved = new Map<string, CometThread['queued']>()
  return store.subscribe(() => {
    const threads = store.getSnapshot().threads
    for (const id of saved.keys()) if (!threads[id]) { try { storage.removeItem(prefix + id) } catch { /* Storage may be unavailable. */ } saved.delete(id) }
    for (const [id, thread] of Object.entries(threads)) {
      if (!saved.has(id) && !thread.queued.length) continue
      if (saved.get(id) === thread.queued) continue
      saved.set(id, thread.queued)
      try { if (thread.queued.length) storage.setItem(prefix + id, JSON.stringify(thread.queued)); else storage.removeItem(prefix + id) } catch { /* Keep the live queue when disk storage is full. */ }
    }
  })
}
