import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { serialWork } from './serial-work.js'

const MAX_BYTES = 1_000_000

let file: string | null = null
let open: (made: Promise<unknown>) => void = () => {}
const ready = new Promise<unknown>(resolve => { open = resolve })
const writes = serialWork()
let dropped = 0

export function initLog(dir: string): void {
  if (file !== null) return
  file = join(dir, 'engram-main.log')
  const made = mkdir(dir, { recursive: true })
  void made.catch(() => undefined)
  open(made)
}

export function flog(tag: string, detail: unknown): void {
  if (writes.pending >= 128) { dropped++; return }
  const text = (detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail)).slice(0, 8192)
  const line = `${new Date().toISOString()} [${tag}] ${text}\n`
  void writes.run(async () => {
    await ready
    const target = file!
    try {
      if ((await stat(target)).size > MAX_BYTES) await rename(target, `${target}.1`)
    } catch {
    }
    const skipped = dropped
    dropped = 0
    await appendFile(target, `${skipped ? `[log-pressure] ${skipped} lines omitted\n` : ''}${line}`)
  }).catch(() => undefined)
}
