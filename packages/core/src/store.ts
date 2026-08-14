import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { expandQueryWithAliases, loadAliasGroups } from './aliases.js'
import { loadNotes, type SkippedNote } from './notes.js'
import type { Note } from './schema.js'
import { noteTitle, parseNote } from './schema.js'
import { buildIndex, searchIndex, searchIndexStrict, type SearchHit } from './search.js'
import type { VaultPaths } from './vault.js'

// In-memory, watcher-driven view over the notes folder. The markdown files are
// the source of truth; this store is a derived cache that stays in sync via
// applyFile() deltas and can always be rebuilt from disk with open().

export interface FileDelta {
  upserts: Note[]
  removed: string[]
}

type NoteIndex = ReturnType<typeof buildIndex>

function byId(a: Note, b: Note): number {
  return a.front.id < b.front.id ? -1 : a.front.id > b.front.id ? 1 : 0
}

export class NoteStore {
  // Keyed by note id. By construction (writeNote) a note's id equals its file
  // stem, so an unlink event — which only carries a path — resolves to the same
  // key as the add/change that parsed the note's frontmatter.
  private readonly notes: Map<string, Note>
  private readonly index: NoteIndex

  // Alias groups (workspace/aliases.md) loaded at open(); a group taught
  // mid-session reaches this store on the next open (workspace switch/boot).
  private readonly aliases: string[][]

  // Files in notes/ that could not be read at open(). Kept so the app can name
  // them instead of a note quietly not being there.
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
    return [...this.notes.values()].sort(byId)
  }

  get(id: string): Note | null {
    return this.notes.get(id) ?? null
  }

  // Strict mode (the capture echo) skips alias expansion: it is a precision
  // pass, and appended alias terms would dilute its coverage requirement.
  search(query: string, opts: { strict?: boolean } = {}): SearchHit[] {
    return opts.strict
      ? searchIndexStrict(this.index, query)
      : searchIndex(this.index, expandQueryWithAliases(query, this.aliases))
  }

  // Fold one watcher event into the store, returning what actually changed.
  // Only .md files sitting directly inside paths.notes are relevant; anything
  // else yields an empty delta. Reads/parses never throw: a partial write seen
  // mid-save keeps the previous version, and the next watcher event retries.
  async applyFile(
    event: 'add' | 'change' | 'unlink',
    absPath: string,
  ): Promise<FileDelta> {
    const stem = this.noteKeyForPath(absPath)
    if (stem === null) return { upserts: [], removed: [] }

    if (event === 'unlink') {
      if (!this.notes.has(stem)) return { upserts: [], removed: [] }
      this.notes.delete(stem)
      if (this.index.has(stem)) this.index.discard(stem)
      return { upserts: [], removed: [stem] }
    }

    let note: Note
    try {
      note = parseNote(await readFile(absPath, 'utf8'))
    } catch {
      // Partial write or transient read error — keep the prior state untouched.
      return { upserts: [], removed: [] }
    }
    const id = note.front.id
    this.notes.set(id, note)
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

  // The note id if absPath is a markdown file directly under paths.notes, else
  // null. Resolve both sides so `.`/`..`/trailing separators do not fool the
  // parent-dir comparison.
  private noteKeyForPath(absPath: string): string | null {
    const ext = extname(absPath)
    if (ext.toLowerCase() !== '.md') return null
    if (resolve(dirname(absPath)) !== resolve(this.paths.notes)) return null
    return basename(absPath, ext)
  }
}
