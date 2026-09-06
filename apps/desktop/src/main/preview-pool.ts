interface Entry<F> {
  listeners: Set<(frame: F) => void>
  ready: Promise<() => Promise<void>>
  last?: F
  release?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

// CDP screencast ownership is per target, even across separate sessions.
// A brief handoff keeps a disappearing view from stopping its replacement.
export function createPreviewPool<K extends object, F>(
  open: (key: K, receive: (frame: F) => void) => Promise<() => Promise<void>>,
  handoffMs = 180,
) {
  const entries = new WeakMap<K, Entry<F>>()
  async function acquire(key: K, receive: (frame: F) => void): Promise<() => void> {
    let entry = entries.get(key)
    if (entry?.closing) {
      await entry.closing
      return acquire(key, receive)
    }
    const listener = (frame: F) => receive(frame)
    if (!entry) {
      const listeners = new Set<(frame: F) => void>([listener])
      const created: Entry<F> = {
        listeners,
        ready: Promise.resolve().then(() => open(key, (frame) => {
          created.last = frame
          for (const notify of created.listeners) notify(frame)
        })),
      }
      entry = created
      entries.set(key, created)
    } else {
      clearTimeout(entry.release)
      entry.release = undefined
      entry.listeners.add(listener)
      if (entry.last !== undefined) receive(entry.last)
    }
    try {
      await entry.ready
    } catch (error) {
      entry.listeners.delete(listener)
      if (entries.get(key) === entry) entries.delete(key)
      throw error
    }
    const held = entry
    let released = false
    return () => {
      if (released) return
      released = true
      held.listeners.delete(listener)
      if (held.listeners.size) return
      held.release = setTimeout(() => {
        held.closing = held.ready.then((stop) => stop()).finally(() => {
          if (entries.get(key) === held) entries.delete(key)
        })
        // The stream owns its teardown errors; consumers have already left.
        void held.closing.catch(() => undefined)
      }, handoffMs)
      held.release.unref()
    }
  }
  return acquire
}
