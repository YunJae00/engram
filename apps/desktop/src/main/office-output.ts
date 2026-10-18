import { app } from 'electron'
import { access, open, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const exists = (path: string) => access(path).then(() => true, () => false)

// Exclusive creation protects both user files and simultaneous generations.
export async function saveOfficeOutput(name: string, extension: '.docx' | '.pptx', data: Buffer, requested?: string, signal?: AbortSignal, assertActive?: () => void): Promise<string> {
  const safe = name.replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) || 'document'
  // A bare file name is a name for the document, kept in the usual folder.
  const bare = requested !== undefined && !isAbsolute(requested) && basename(requested) === requested
  const stem = bare ? requested.replace(/\.(docx|pptx)$/i, '').replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) : ''
  const folder = join(app.getPath('documents'), 'Engram')
  const path = requested !== undefined && !bare ? requested
    : stem ? (await exists(join(folder, stem + extension)) ? join(folder, `${stem}-${randomUUID().slice(0, 8)}${extension}`) : join(folder, stem + extension))
      : join(folder, `${safe}-${randomUUID()}` + extension)
  if (!isAbsolute(path) || extname(path).toLowerCase() !== extension || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(basename(path)) || basename(path).includes(':')) throw new Error(`Use an absolute ${extension} file path.`)
  if (data.length > 8_000_000) throw new Error('Generated output exceeds 8 MB.')
  signal?.throwIfAborted()
  assertActive?.()
  await mkdir(dirname(path), { recursive: true })
  signal?.throwIfAborted()
  assertActive?.()
  const handle = await open(path, 'wx+')
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
