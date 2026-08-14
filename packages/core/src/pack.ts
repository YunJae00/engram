import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { badgeOf } from './freshness.js'
import { ancestorsOf, buildLineage } from './lineage.js'
import type { Note } from './schema.js'
import { noteTitle } from './schema.js'
import type { VaultPaths } from './vault.js'

// Context pack: current notes ONLY, each with a one-line lineage
// summary so the model knows what superseded what — stale text never leaks
// into a prompt.

export interface PackOptions {
  // Optional filter: only notes whose title/body matches (case-insensitive).
  query?: string
  now?: Date
}

export function buildContextPack(notes: Note[], options: PackOptions = {}): string {
  const now = options.now ?? new Date()
  const graph = buildLineage(notes)
  const current = notes.filter((n) => n.front.status === 'current')
  const matches = options.query
    ? current.filter((n) => (noteTitle(n) + '\n' + n.body).toLowerCase().includes(options.query!.toLowerCase()))
    : current

  const sections = matches.map((note) => {
    const ancestors = ancestorsOf(graph, note.front.id)
    const chainLine =
      ancestors.length > 0
        ? `\n> lineage: supersedes ${ancestors
            .map((a) => `${noteTitle(a)} (${(a.front.happened_at ?? a.front.created).slice(0, 10)})`)
            .join(' ← ')}`
        : ''
    const meta = `> ${badgeOf(note, now)} ${note.front.type} · ${note.front.id}${
      note.front.happened_at ? ` · happened ${note.front.happened_at.slice(0, 10)}` : ''
    }`
    return `## ${noteTitle(note)}\n\n${meta}${chainLine}\n\n${note.body.trim()}`
  })

  return [
    '# Context pack',
    '',
    `> generated ${now.toISOString()} · ${matches.length} current note(s); superseded/disputed versions excluded`,
    '',
    ...sections,
    '',
  ].join('\n')
}

export async function writeContextPack(paths: VaultPaths, content: string, now: Date = new Date()): Promise<string> {
  await mkdir(paths.views, { recursive: true })
  const file = `pack-${now.toISOString().replace(/[:.]/g, '-')}.md`
  await writeFile(join(paths.views, file), content)
  // Vault-relative reference — always POSIX-style, independent of host OS.
  return `_views/${file}`
}
