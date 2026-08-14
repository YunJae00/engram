import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeCapture } from './parsers.js'

export interface CaptureResult {
  // the inbox file holding this text — either freshly written, or the
  // already-pending item that carries the identical text
  file: string
  // true when an identical capture was already waiting and nothing was written
  duplicate: boolean
}

export type CaptureOrigin = 'user' | 'session'

// The marker rides in the capture file rather than out of band, because the
// inbox is a plain folder a user can drop files into and nothing else survives
// the trip through J1 into the note.
const ORIGIN_MARKER = '<!-- engram:origin='

export function markOrigin(text: string, origin: CaptureOrigin): string {
  return origin === 'user' ? text : `${ORIGIN_MARKER}${origin} -->\n${text}`
}

export function readOrigin(text: string): CaptureOrigin {
  const match = new RegExp(`^${ORIGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\w+) -->`).exec(text.trimStart())
  return match?.[1] === 'session' ? 'session' : 'user'
}

const CONTEXT_MARKER = '<!-- engram:context='

// One line, safe inside an HTML comment, short enough to stay a label.
export function sanitizeContext(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.replace(/-->/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
}

export function markContext(text: string, context: string | null | undefined): string {
  const label = sanitizeContext(context)
  return label ? `${CONTEXT_MARKER}${label} -->\n${text}` : text
}

// The marker may sit on the first line or right after the origin marker —
// search the head of the file rather than assuming a position.
export function readContext(text: string): string | undefined {
  const match = /<!-- engram:context=([^>\r\n]*?) -->/.exec(text.slice(0, 400))
  const label = match?.[1]?.trim()
  return label || undefined
}

// What travels into prompts and note bodies is the capture's CONTENT — the
// provenance markers are bookkeeping between writeCapture and J1, and an
// engine must never be tempted to copy them into a memory.
export function stripProvenanceMarkers(text: string): string {
  return text.replace(/^\s*<!-- engram:(?:origin|context)=[^>]*? -->\r?\n?/gm, '')
}

export async function writeCapture(
  inboxDir: string,
  text: string,
  origin: CaptureOrigin = 'user',
  context?: string,
): Promise<CaptureResult> {
  const body = markOrigin(markContext(normalizeCapture(text), context), origin) + '\n'
  const existing = await pendingDuplicate(inboxDir, body)
  if (existing) return { file: existing, duplicate: true }
  // Millisecond timestamps collide: two distinct captures written inside the
  // same millisecond would land on one filename and the second would overwrite
  // the first. Claim the name with an exclusive create and step the suffix
  // until one is free.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let n = 0; ; n++) {
    const file = n === 0 ? `${stamp}-capture.md` : `${stamp}-${n}-capture.md`
    try {
      await writeFile(join(inboxDir, file), body, { flag: 'wx' })
      return { file, duplicate: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

async function pendingDuplicate(inboxDir: string, body: string): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(inboxDir)
  } catch {
    return null // no inbox yet — nothing to collide with
  }
  const target = body.trim()
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    try {
      if ((await readFile(join(inboxDir, name), 'utf8')).trim() === target) return name
    } catch {
      // vanished mid-scan (the librarian just filed it) — not a duplicate
    }
  }
  return null
}
