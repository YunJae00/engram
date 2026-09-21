import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, opendir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { devEditPreview, devLocalPath } from './dev-edit.js'
import type { DevFile, DevFileEntry, DevFileMatch } from '../shared/developers.js'

const limit = 500_000
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')
async function local(root: string, path: string): Promise<string> {
  if (typeof path !== 'string' || path.length > 4000 || isAbsolute(path) || /[:\0]/.test(path) || !(await devLocalPath(root, path))) throw new Error('Choose a non-sensitive file inside this workspace.')
  return realpath(resolve(root, path))
}

export async function devFiles(root: string, path: string): Promise<{ entries: DevFileEntry[]; truncated: boolean }> {
  const directory = await local(root, path), entries: DevFileEntry[] = []
  let scanned = 0, truncated = false
  for await (const entry of await opendir(directory)) {
    if (++scanned > 2000 || entries.length >= 500) { truncated = true; break }
    if (['node_modules', '.git', '.engram'].includes(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
    const target = join(directory, entry.name)
    if (!(await devLocalPath(root, target))) continue
    entries.push({ path: relative(root, target).replaceAll('\\', '/'), name: entry.name, directory: entry.isDirectory() })
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  return { entries, truncated }
}

export async function devReadFile(root: string, path: string): Promise<DevFile> {
  const target = await local(root, path), handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('The editor supports text files up to 500 KB.')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead }
    if (size > limit || buffer.subarray(0, size).includes(0)) throw new Error('The editor supports text files up to 500 KB.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)) }
    catch { throw new Error('This file is not UTF-8 text. Open it in an external editor.') }
    return { path: relative(root, target).replaceAll('\\', '/'), text, fingerprint: fingerprint(text) }
  } finally { await handle.close() }
}

export async function devCreateFile(root: string, path: string, assertWritable: () => void): Promise<DevFile> {
  if (typeof path !== 'string' || !path.trim() || path.length > 4000 || isAbsolute(path) || /[:\0]/.test(path)) throw new Error('Choose a relative file path.')
  const parent = await local(root, dirname(path)), target = resolve(root, path)
  if (parent !== await realpath(dirname(target)) || !(await devEditPreview(root, 'Write', { file_path: target, content: '' }))) throw new Error('Choose a non-sensitive file inside this workspace.')
  assertWritable()
  // Exclusive creation never truncates an existing file or follows a final symlink.
  const handle = await open(target, 'wx', 0o600)
  await handle.close()
  return devReadFile(root, path)
}

export async function devSearchFiles(root: string, query: string): Promise<{ matches: DevFileMatch[]; truncated: boolean }> {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Enter search text up to 200 characters.')
  const needle = query.toLowerCase(), matches: DevFileMatch[] = [], folders = ['']
  let visited = 0, bytes = 0, truncated = false
  // ponytail: bounded literal search; an indexed search is needed for larger repositories.
  while (folders.length && visited < 2000 && bytes < 20_000_000 && matches.length < 100) {
    const listing = await devFiles(root, folders.shift()!)
    truncated ||= listing.truncated
    for (const entry of listing.entries) {
      if (++visited > 2000 || bytes >= 20_000_000 || matches.length >= 100) { truncated = true; break }
      if (entry.directory) { if (!['dist', 'out', 'build', 'coverage', 'vendor'].includes(entry.name)) folders.push(entry.path); continue }
      if (entry.path.toLowerCase().includes(needle)) { matches.push({ path: entry.path }); continue }
      try {
        const file = await devReadFile(root, entry.path); bytes += Buffer.byteLength(file.text)
        const lines = file.text.split(/\r?\n/)
        for (let line = 0; line < lines.length && matches.length < 100; line++) {
          const at = lines[line]!.toLowerCase().indexOf(needle)
          if (at !== -1) matches.push({ path: entry.path, line: line + 1, text: lines[line]!.slice(Math.max(0, at - 60), at + 180) })
        }
      } catch { /* Binary, oversized or concurrently removed files are not search results. */ }
    }
  }
  return { matches, truncated: truncated || folders.length > 0 || matches.length >= 100 }
}

export async function devSaveFile(root: string, path: string, expected: string, text: string, backupRoot: string, assertWritable: () => void): Promise<DevFile> {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit || text.includes('\0') || typeof expected !== 'string') throw new Error('Enter UTF-8 text up to 500 KB.')
  const before = await devReadFile(root, path)
  if (before.fingerprint !== expected) throw new Error('This file changed on disk. Your draft is kept. Reload before saving.')
  const target = await local(root, path), info = await stat(target)
  await mkdir(backupRoot, { recursive: true })
  await writeFile(join(backupRoot, `${randomUUID()}.json`), JSON.stringify({ path: target, before: before.text, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  const pending = `${target}.${randomUUID()}.engram-edit`
  await writeFile(pending, text, { flag: 'wx', mode: info.mode })
  if ((await devReadFile(root, path)).fingerprint !== expected || await local(root, path) !== target) throw new Error('This file changed during save. Your draft is kept; reload before saving.')
  assertWritable()
  // Keep the pending file and backup on a failed replacement for recovery.
  await rename(pending, target)
  return { path: before.path, text, fingerprint: fingerprint(text) }
}
