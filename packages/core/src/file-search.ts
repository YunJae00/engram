import { opendir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { FileFound, FileSearchResult } from './file-work.js'
import { TEXT_FILE_EXTENSIONS } from './file-work.js'
import { DOCUMENT_EXTENSIONS } from './document-tools.js'

const extensions = new Set([...TEXT_FILE_EXTENSIONS, ...DOCUMENT_EXTENSIONS, '.pdf', '.xlsm'])
const skip = new Set(['node_modules', 'appdata', 'library'])
const within = (root: string, path: string) => { const part = relative(root, path); return !part || (part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part)) }

// Names only; links are not traversed and private paths must resolve before scanning.
export async function findLocalFiles(roots: string[], privateDir: string, query: string, signal?: AbortSignal): Promise<FileSearchResult> {
  signal?.throwIfAborted()
  const privateRoot = await realpath(privateDir)
  const tokens = query.normalize('NFC').toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length || query.length > 120) throw new Error('Supply a filename query up to 120 characters.')
  const matches: FileFound[] = []
  const visited = new Set<string>()
  let scanned = 0, limited = false, ended = false
  const deadline = Date.now() + 2500
  const stopped = () => ended || signal?.aborted || scanned >= 8000 || matches.length >= 40 || Date.now() >= deadline
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (stopped()) { limited = true; return }
    if (within(privateRoot, dir) || visited.has(dir)) return
    visited.add(dir)
    try {
      const handle = await opendir(dir)
      for await (const entry of handle) {
        if (stopped()) { limited = true; break }
        scanned++
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (within(privateRoot, path)) continue
        if (entry.isDirectory()) {
          if (skip.has(entry.name.toLowerCase())) continue
          if (depth >= 4) { limited = true; continue }
          await walk(path, depth + 1)
        } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase()) && tokens.every(token => entry.name.normalize('NFC').toLocaleLowerCase().includes(token))) {
          const info = await stat(path).catch(() => undefined)
          if (stopped()) { limited = true; break }
          matches.push({ path, name: entry.name, folder: dir, ...(info ? { modified: info.mtime.toISOString() } : {}) })
        }
      }
    } catch { limited = true }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    await Promise.race([
      (async () => { for (const root of roots) { if (stopped()) break; const path = await realpath(root).catch(() => null); if (path) await walk(path, 0); else limited = true } })(),
      new Promise<void>(resolve => { timer = setTimeout(() => { limited = true; ended = true; resolve() }, 2500); cancel = () => { ended = true; resolve() }; signal?.addEventListener('abort', cancel, { once: true }) }),
    ])
    signal?.throwIfAborted()
    return { matches: matches.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? '')).slice(0, 20), limited: limited || scanned >= 8000 || matches.length > 20 }
  } finally { ended = true; clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel) }
}
