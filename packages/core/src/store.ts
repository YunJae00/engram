import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { expandQueryWithAliases, loadAliasGroups } from './aliases.js'
import { loadNotes, type SkippedNote } from './notes.js'
import type { Note } from './schema.js'
import { noteTitle, parseNote } from './schema.js'
import { buildIndex, searchIndex, searchIndexStrict, type SearchHit } from './search.js'
import type { VaultPaths } from './vault.js'

interface FileDelta {
  upserts: Note[]
  removed: string[]
}

type NoteIndex = ReturnType<typeof buildIndex>

function byId(a: Note, b: Note): number {
  return a.front.id < b.front.id ? -1 : a.front.id > b.front.id ? 1 : 0
}

export class NoteStore {
  private readonly notes: Map<string, Note>
  private readonly index: NoteIndex
  private sorted: Note[] | null = null

  private readonly aliases: string[][]

  readonly skipped: readonly SkippedNote[]

  private constructor(
    private readonly paths: VaultPaths,
    notes: Map<string, Note>,
    index: NoteIndex,
    aliases: string[][],
    skipped: SkippedNote[],
  ) {
    this.notes = notes
    this.index = index
    this.aliases = aliases
    this.skipped = skipped
  }

  static async open(paths: VaultPaths): Promise<NoteStore> {
    const skipped: SkippedNote[] = []
    const loaded = await loadNotes(paths, (s) => skipped.push(s))
    const notes = new Map<string, Note>()
    for (const note of loaded) notes.set(note.front.id, note)
    return new NoteStore(paths, notes, buildIndex(loaded), await loadAliasGroups(paths), skipped)
  }

  getAll(): Note[] {
    return (this.sorted ??= [...this.notes.values()].sort(byId)).slice()
  }

  get(id: string): Note | null {
    return this.notes.get(id) ?? null
  }

  search(query: string, opts: { strict?: boolean } = {}): SearchHit[] {
    return opts.strict
      ? searchIndexStrict(this.index, query)
      : searchIndex(this.index, expandQueryWithAliases(query, this.aliases))
  }

  async applyFile(
    event: 'add' | 'change' | 'unlink',
    absPath: string,
  ): Promise<FileDelta> {
    const stem = this.noteKeyForPath(absPath)
    if (stem === null) return { upserts: [], removed: [] }

    if (event === 'unlink') {
      if (!this.notes.has(stem)) return { upserts: [], removed: [] }
      this.notes.delete(stem)
      this.sorted = null
      if (this.index.has(stem)) this.index.discard(stem)
      return { upserts: [], removed: [stem] }
    }

    let note: Note
    try {
      note = parseNote(await readFile(absPath, 'utf8'))
    } catch {
      return { upserts: [], removed: [] }
    }
    const id = note.front.id
    this.notes.set(id, note)
    this.sorted = null
    if (this.index.has(id)) this.index.discard(id)
    this.index.add({
      id,
      title: noteTitle(note),
      body: note.body,
      type: note.front.type,
      status: note.front.status,
    })
    return { upserts: [note], removed: [] }
  }

  private noteKeyForPath(absPath: string): string | null {
    const ext = extname(absPath)
    if (ext.toLowerCase() !== '.md') return null
    if (resolve(dirname(absPath)) !== resolve(this.paths.notes)) return null
    return basename(absPath, ext)
  }
}
