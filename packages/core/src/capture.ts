import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeCapture } from './parsers.js'

export interface CaptureResult {
  file: string
  duplicate: boolean
}

export type CaptureOrigin = 'user' | 'session'

const ORIGIN_MARKER = '<!-- engram:origin='

export function markOrigin(text: string, origin: CaptureOrigin): string {
  return origin === 'user' ? text : `${ORIGIN_MARKER}${origin} -->\n${text}`
}

export function readOrigin(text: string): CaptureOrigin {
  const match = new RegExp(`^${ORIGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\w+) -->`).exec(text.trimStart())
  return match?.[1] === 'session' ? 'session' : 'user'
}

const CONTEXT_MARKER = '<!-- engram:context='

export function sanitizeContext(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.replace(/-->/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
}

export function markContext(text: string, context: string | null | undefined): string {
  const label = sanitizeContext(context)
  return label ? `${CONTEXT_MARKER}${label} -->\n${text}` : text
}

export function readContext(text: string): string | undefined {
  const match = /<!-- engram:context=([^>\r\n]*?) -->/.exec(text.slice(0, 400))
  const label = match?.[1]?.trim()
  return label || undefined
}

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
    return null
  }
  const target = body.trim()
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    try {
      if ((await readFile(join(inboxDir, name), 'utf8')).trim() === target) return name
    } catch {
    }
  }
  return null
}
