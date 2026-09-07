import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { serialWork } from './serial-work.js'

const MAX_BYTES = 1_000_000

let dir: string | null = null
let ready: Promise<unknown> | null = null
const writes = serialWork()
let dropped = 0

function logFile(): string | null {
  if (dir === null) {
    try {
      dir = join(app.getPath('userData'), 'logs')
      ready = mkdir(dir, { recursive: true })
      void ready.catch(() => undefined)
    } catch {
      return null // userData unavailable (very early boot) — drop the line
    }
  }
  return join(dir, 'engram-main.log')
}

export function flog(tag: string, detail: unknown): void {
  const file = logFile()
  if (!file) return
  if (writes.pending >= 128) { dropped++; return }
  const text = (detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)).slice(0, 8192)
  const line = `${new Date().toISOString()} [${tag}] ${text}\n`
  void writes.run(async () => {
    await ready
    try {
      if ((await stat(file)).size > MAX_BYTES) await rename(file, `${file}.1`)
    } catch {
      /* first write */
    }
    const skipped = dropped
    dropped = 0
    await appendFile(file, `${skipped ? `[log-pressure] ${skipped} lines omitted\n` : ''}${line}`)
  }).catch(() => undefined)
}
