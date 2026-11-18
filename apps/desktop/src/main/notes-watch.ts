import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

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
    return out
  }
  const files = names.filter(name => extname(name).toLowerCase() === '.md')
  for (let offset = 0; offset < files.length; offset += 32) {
    await Promise.all(files.slice(offset, offset + 32).map(async name => {
      try {
        const s = await stat(join(dir, name))
        if (s.isFile()) out.set(name, { mtimeMs: s.mtimeMs, size: s.size })
      } catch {
      }
    }))
  }
  return out
}

export function watchNotes(
  notesDir: string,
  onBatch: (events: Array<{ event: NotesFileEvent; path: string }>) => void | Promise<void>,
  intervalMs = 2_000,
): NotesWatchHandle {
  const committed = new Map<string, number>()
  const pending = new Map<string, Stamp>()
  let closed = false
  let seeded = false
  let timer: ReturnType<typeof setTimeout> | null = null
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
        pending.set(name, s)
      }
    }
    for (const name of [...committed.keys()]) {
      if (!cur.has(name)) {
        events.push({ event: 'unlink', path: join(notesDir, name) })
        commits.push({ name, mtimeMs: null })
        pending.delete(name)
      }
    }

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
