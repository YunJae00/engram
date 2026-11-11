import { useEffect, useSyncExternalStore } from 'react'

type Entry = { url?: string; loading: boolean }
const entries = new Map<string, Entry>()
const wanted = new Map<string, number>()
const listeners = new Set<() => void>()
const keyOf = (id: string, image: string) => `${id}\n${image}`
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

function ensure(id: string, image: string): void {
  const key = keyOf(id, image)
  if (entries.has(key)) return
  const entry: Entry = { loading: true }
  entries.set(key, entry)
  const load = globalThis.window?.engram?.botAvatarImage(id)
  if (!load) { entry.loading = false; return }
  load.then((result) => {
    entry.loading = false
    if (result && entries.get(key) === entry) entry.url = URL.createObjectURL(new Blob([result.data as BlobPart], { type: result.mime }))
    notify()
  }, () => { entry.loading = false; notify() })
}

export function useBotImage(id: string, image: string | null): string | undefined {
  useEffect(() => {
    if (image === null) return
    const key = keyOf(id, image)
    wanted.set(key, (wanted.get(key) ?? 0) + 1)
    ensure(id, image)
    return () => {
      const left = (wanted.get(key) ?? 1) - 1
      if (left > 0) wanted.set(key, left); else wanted.delete(key)
    }
  }, [id, image])
  return useSyncExternalStore(subscribe, () => (image === null ? undefined : entries.get(keyOf(id, image))?.url), () => undefined)
}

export function forgetBotImage(id: string): void {
  const prefix = `${id}\n`
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue
    if (entry.url) URL.revokeObjectURL(entry.url)
    entries.delete(key)
  }
  for (const key of wanted.keys()) if (key.startsWith(prefix)) ensure(id, key.slice(prefix.length))
  notify()
}
