import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import matter from 'gray-matter'
import { generateNoteId } from './id.js'
import { loadNotes, readNote, writeNote } from './notes.js'
import { frontmatterSchema, type NoteFrontmatter } from './schema.js'
import { serializeNote } from './schema.js'
import type { VaultPaths } from './vault.js'

// Bulk import: recursive .md/.txt collection, COPY only —
// originals are never touched. Imported notes are searchable immediately;
// absorption (linking, dating, dedup) happens gradually via the sweep queue.

export interface ImportScan {
  files: string[]
  totalBytes: number
}

export async function scanImportFolder(folder: string): Promise<ImportScan> {
  const files: string[] = []
  let totalBytes = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (['.md', '.txt'].includes(extname(entry.name).toLowerCase())) {
        files.push(path)
        totalBytes += (await stat(path)).size
      }
    }
  }
  await walk(folder)
  return { files: files.sort(), totalBytes }
}

export interface AbsorbState {
  pending: string[]
  total: number
}

const ABSORB_FILE = 'absorb.json'

export async function loadAbsorbState(paths: VaultPaths): Promise<AbsorbState> {
  try {
    return JSON.parse(await readFile(join(paths.cache, ABSORB_FILE), 'utf8')) as AbsorbState
  } catch {
    return { pending: [], total: 0 }
  }
}

export async function saveAbsorbState(paths: VaultPaths, state: AbsorbState): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  await writeFile(join(paths.cache, ABSORB_FILE), JSON.stringify(state))
}

export interface ImportReport {
  imported: number
  queued: number
}

// Folder-name → note type inference: a vault exported from another tool
// usually encodes the type in its directory names (en + ko synonyms). Explicit
// frontmatter always wins; unmapped folders stay 'imported'.
const FOLDER_TYPES: Array<[RegExp, string]> = [
  [/^troubleshootings?$|^트러블슈팅$/i, 'troubleshooting'],
  [/^decisions?$|^결정$/i, 'decision'],
  [/^how-?tos?$|^guides?$|^가이드$/i, 'howto'],
  [/^logs?$|^journals?$|^일지$|^기록$/i, 'log'],
  [/^concepts?$|^개념$/i, 'concept'],
  [/^facts?$|^사실$/i, 'fact'],
  [/^questions?$|^질문$/i, 'question'],
  [/^events?$|^사건$/i, 'event'],
]

export function inferTypeFromFolder(relPath: string): string | null {
  const parts = relPath.split(/[\\/]/)
  if (parts.length < 2) return null // file at the import root — no folder to read
  const segment = parts[0]!
  for (const [pattern, type] of FOLDER_TYPES) if (pattern.test(segment)) return type
  return null
}

// Existing frontmatter is mapped onto the schema; missing fields are filled.
// Files without frontmatter come in verbatim as the note body.
export async function runImport(
  paths: VaultPaths,
  folder: string,
  options: { onProgress?(done: number, total: number): void; now?: Date } = {},
): Promise<ImportReport> {
  const now = options.now ?? new Date()
  const { files } = await scanImportFolder(folder)
  const state = await loadAbsorbState(paths)
  let done = 0

  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    const rel = relative(folder, file)
    const digest = createHash('sha1').update(rel + '\n' + raw).digest('hex').slice(0, 6)
    const id = `n-imp${digest}-${generateNoteId(now).slice(-6)}`
    const { data, content } = matter(raw)
    const front: NoteFrontmatter = frontmatterSchema.parse({
      type: inferTypeFromFolder(rel) ?? 'imported',
      ...data,
      id,
      created: (data['created'] as string | undefined) ?? now.toISOString(),
      updated: now.toISOString(),
      source: `import:${rel}`,
    })
    await writeFile(join(paths.notes, `${id}.md`), serializeNote({ front, body: content.trim() || raw.trim() }))
    state.pending.push(id)
    state.total++
    done++
    options.onProgress?.(done, files.length)
  }

  await saveAbsorbState(paths, state)
  return { imported: done, queued: state.pending.length }
}

// One-time repair for vaults imported before folder-type inference existed:
// 'imported' notes whose source folder maps to a known type are reclassified.
// `updated` stays untouched on purpose — a metadata correction must not push
// the note back into the next sweep's delta.
export async function reclassifyImported(paths: VaultPaths): Promise<number> {
  let changed = 0
  for (const note of await loadNotes(paths)) {
    if (note.front.type !== 'imported' || !note.front.source?.startsWith('import:')) continue
    const inferred = inferTypeFromFolder(note.front.source.slice('import:'.length))
    if (!inferred) continue
    const full = await readNote(paths, note.front.id)
    full.front.type = inferred
    await writeNote(paths, full)
    changed++
  }
  return changed
}

export async function takeAbsorbBatch(paths: VaultPaths, size: number): Promise<string[]> {
  const state = await loadAbsorbState(paths)
  const batch = state.pending.slice(0, size)
  if (batch.length > 0) {
    state.pending = state.pending.slice(size)
    await saveAbsorbState(paths, state)
  }
  return batch
}
