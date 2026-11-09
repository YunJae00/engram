import { app } from 'electron'
import { open, mkdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'

const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

// Exclusive creation protects both user files and simultaneous generations.
export async function saveOfficeOutput(name: string, extension: '.docx' | '.pptx', data: Buffer, requested?: string, signal?: AbortSignal, assertActive?: () => void): Promise<string> {
  const safe = name.replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) || 'document'
  // A bare file name is a name for the document, kept in the usual folder.
  const bare = requested !== undefined && !isAbsolute(requested) && basename(requested) === requested
  const stem = bare ? requested.replace(/\.(docx|pptx)$/i, '').replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) : ''
  const folder = join(app.getPath('documents'), 'Engram')
  const explicit = requested !== undefined && !bare
  const base = stem || safe
  // The suffix stays inside the file name so a name like '..' cannot leave the folder.
  const candidates = explicit ? [requested] : Array.from({ length: 99 }, (_, i) => join(folder, `${base}${i ? ` (${i + 1})` : ''}${extension}`)).filter((c) => !reserved.test(basename(c)))
  for (const path of candidates) if (!isAbsolute(path) || extname(path).toLowerCase() !== extension || reserved.test(basename(path)) || basename(path).includes(':')) throw new Error(`Use an absolute ${extension} file path.`)
  if (data.length > 8_000_000) throw new Error('Generated output exceeds 8 MB.')
  signal?.throwIfAborted()
  assertActive?.()
  await mkdir(dirname(candidates[0] ?? join(folder, base)), { recursive: true })
  let path = ''
  let handle: FileHandle | undefined
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    assertActive?.()
    try {
      handle = await open(candidate, 'wx+')
      path = candidate
      break
    } catch (error) {
      if (explicit || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (!handle) throw new Error(`Too many files named "${base}" in ${folder}. Choose a different name.`)
  try {
    signal?.throwIfAborted()
    assertActive?.()
    await handle.writeFile(data)
    await handle.sync()
    const actual = Buffer.alloc(data.length)
    let offset = 0
    while (offset < actual.length) {
      const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== data.length || !actual.equals(data)) throw new Error(`Output readback failed: ${path}. Inspect this partial file before continuing.`)
  } catch (error) {
    throw new Error(`Output may be incomplete at ${path}. Inspect it before continuing.`, { cause: error })
  } finally { await handle.close() }
  signal?.throwIfAborted()
  assertActive?.()
  return path
}
