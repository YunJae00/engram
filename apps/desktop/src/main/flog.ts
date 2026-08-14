import { appendFileSync, renameSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const MAX_BYTES = 1_000_000

let dir: string | null = null

function logFile(): string | null {
  if (dir === null) {
    try {
      dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
    } catch {
      return null // userData unavailable (very early boot) — drop the line
    }
  }
  return join(dir, 'engram-main.log')
}

export function flog(tag: string, detail: unknown): void {
  const file = logFile()
  if (!file) return
  const text = detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)
  try {
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`) // keep one generation
    } catch {
      /* first write */
    }
    appendFileSync(file, `${new Date().toISOString()} [${tag}] ${text}\n`)
  } catch {
    /* a log that cannot write must never become the error */
  }
}
