import { app, shell } from 'electron'
import { open, mkdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { Packer } from 'docx'
import { composeDeck, type DeckSpec } from './deck-render.js'
import { composeDoc, type DocSpec } from './doc-render.js'
import { reserved } from './office-output.js'

export async function saveOfficeOutput(name: string, extension: '.docx' | '.pptx', data: Buffer, requested?: string, signal?: AbortSignal, assertActive?: () => void): Promise<string> {
  const safe = name.replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) || 'document'
  const bare = requested !== undefined && !isAbsolute(requested) && basename(requested) === requested
  const stem = bare ? requested.replace(/\.(docx|pptx)$/i, '').replace(/[^\p{L}\p{N}_ .-]/gu, ' ').trim().slice(0, 60) : ''
  const folder = join(app.getPath('documents'), 'Engram')
  const explicit = requested !== undefined && !bare
  const base = stem || safe
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

function deckName(name: string): string {
  return (name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'deck')
}

export async function renderDeck(spec: DeckSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; slides: number }> {
  const data = await composeDeck(spec)
  const path = await saveOfficeOutput(deckName(spec.slides[0]?.title ?? spec.title ?? 'deck'), '.pptx', data, spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, slides: spec.slides.length }
}

function docName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document'
}

export async function renderDoc(spec: DocSpec, open = true, signal?: AbortSignal, assertActive?: () => void): Promise<{ path: string; blocks: number }> {
  const path = await saveOfficeOutput(docName(spec.title ?? 'document'), '.docx', await Packer.toBuffer(composeDoc(spec)), spec.saveAs, signal, assertActive)
  if (open) { signal?.throwIfAborted(); assertActive?.(); const error = await shell.openPath(path); if (error) throw new Error(`Saved ${path}, but opening failed: ${error}`) }
  return { path, blocks: spec.blocks.length }
}
