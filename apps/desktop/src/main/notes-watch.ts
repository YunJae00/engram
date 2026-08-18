import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

// Notes-folder watcher for the NoteStore delta feed. Deliberately a small
// polling reconcile rather than a chokidar dependency: a poll behaves the same
// on every filesystem (Windows, macOS, Linux, network mounts) with node:fs
// only — no new runtime dependency and no native bindings.
//
// It mirrors the two chokidar behaviours the store relies on:
//   • ignoreInitial — the first scan seeds the baseline silently (NoteStore.open
//     already loaded that state), so boot does not replay every note as a delta.
//   • awaitWriteFinish — a change is only reported once its mtime+size have held
//     steady across a full poll interval, so a half-written file is never read
//     mid-save (NoteStore.applyFile also tolerates a partial read, belt & braces).

type NotesFileEvent = 'add' | 'change' | 'unlink'

export interface NotesWatchHandle {
  close(): Promise<void>
}

interface Stamp {
  mtimeMs: number
  size: number
}

async function snapshot(dir: string): Promise<Map<string, Stamp>> {
  const out = new Map<string, Stamp>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return out // folder not created yet — treat as empty
  }
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.md') continue
    try {
      const s = await stat(join(dir, name))
      if (s.isFile()) out.set(name, { mtimeMs: s.mtimeMs, size: s.size })
    } catch {
      /* vanished between readdir and stat — next tick reconciles */
    }
  }
  return out
}

export function watchNotes(
  notesDir: string,
  onBatch: (events: Array<{ event: NotesFileEvent; path: string }>) => void | Promise<void>,
  intervalMs = 2_000,
): NotesWatchHandle {
  // mtimeMs already folded into the store; only differences from this map emit.
  const committed = new Map<string, number>()
  // Seen-but-not-yet-stable files (the awaitWriteFinish staging area).
  const pending = new Map<string, Stamp>()
  let closed = false
  let seeded = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Consecutive quiet ticks. A scan is a readdir plus a stat per note, and on a
  // large vault — or one on OneDrive or a network mount, where every stat can
  // reach a sync provider — polling that at the base rate around the clock is
  // the app's idle CPU floor for no benefit: a vault nobody is editing produces
  // the same empty diff every time. Two watchers run (notes/, inbox/), so the
  // cost doubles. Any tick with something to report drops straight back to the
  // base interval, so the first change after a quiet stretch costs one long
  // wait and everything after it is as responsive as before.
  let quiet = 0

  async function tick(): Promise<void> {
    if (closed) return
    const cur = await snapshot(notesDir)
    if (closed) return

    if (!seeded) {
      for (const [name, s] of cur) committed.set(name, s.mtimeMs)
      seeded = true
      return
    }

    // Stamp mutations are STAGED and folded in only after onBatch resolves —
    // committed up front, a throwing batch loses its events for good: the
    // next tick sees the stamps as current and never re-emits.
    const events: Array<{ event: NotesFileEvent; path: string }> = []
    const commits: Array<{ name: string; mtimeMs: number | null }> = []
    for (const [name, s] of cur) {
      const known = committed.get(name)
      if (known !== undefined && known === s.mtimeMs) {
        pending.delete(name)
        continue
      }
      const held = pending.get(name)
      if (held && held.mtimeMs === s.mtimeMs && held.size === s.size) {
        events.push({ event: known === undefined ? 'add' : 'change', path: join(notesDir, name) })
        commits.push({ name, mtimeMs: s.mtimeMs })
        pending.delete(name)
      } else {
        pending.set(name, s) // stage; require one stable interval before reading
      }
    }
    for (const name of [...committed.keys()]) {
      if (!cur.has(name)) {
        events.push({ event: 'unlink', path: join(notesDir, name) })
        commits.push({ name, mtimeMs: null })
        pending.delete(name)
      }
    }

    // A staged file counts as activity even before it emits: it is one interval
    // away from an event, and backing off there would stretch awaitWriteFinish
    // into the slow schedule.
    quiet = events.length > 0 || pending.size > 0 ? 0 : quiet + 1

    if (events.length > 0) {
      try {
        await onBatch(events)
      } catch (err) {
        console.error('notes-watch batch failed — events retry next tick:', err)
        return
      }
      for (const { name, mtimeMs } of commits) {
        if (mtimeMs === null) committed.delete(name)
        else committed.set(name, mtimeMs)
      }
    }
  }

  // Multiples of the base interval, so a caller that polls faster keeps its own
  // scale: at the 2s default that is 2s while anything is happening, 10s after
  // half a minute of quiet, and a 30s ceiling five minutes after that.
  const delay = (): number => {
    if (quiet < 15) return intervalMs
    if (quiet < 45) return intervalMs * 5
    return intervalMs * 15
  }

  const loop = (): void => {
    if (closed) return
    timer = setTimeout(() => void tick().finally(loop), delay())
  }
  void tick().finally(loop)

  return {
    close: async () => {
      closed = true
      if (timer) clearTimeout(timer)
    },
  }
}
