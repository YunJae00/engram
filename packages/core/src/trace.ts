import { noteTitle, type Note } from './schema.js'

const EDGE_CAP = 8
const SIBLING_CAP = 5
const LINEAGE_DEPTH = 3

function line(note: Note, suffix = ''): string {
  const date = (note.front.happened_at ?? note.front.updated).slice(0, 10)
  return `[${noteTitle(note)}] (${note.front.id}, ${note.front.status}, ${date})${suffix}`
}

function overflow(total: number, cap: number): string {
  return total > cap ? `\n  … +${total - cap} more` : ''
}

export function traceNote(notes: Note[], seedId: string): string | null {
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  const seed = byId.get(seedId)
  if (!seed) return null

  const parts: string[] = []
  const flags: string[] = []
  if (seed.front.context) flags.push(`folder: ${seed.front.context}`)
  if (seed.front.open_loop === true) flags.push('OPEN LOOP — still wants something')
  if (seed.front.origin === 'session') flags.push('machine-harvested')
  parts.push(`${line(seed)}${flags.length > 0 ? `\n  ${flags.join(' · ')}` : ''}`)

  // Outgoing: this memory's own links, with the librarian's reason when it
  // wrote one down. Incoming: who points here, with THEIR reason about us.
  const reasons = seed.front.link_reasons ?? {}
  const out = seed.front.derived_from
    .map((id) => byId.get(id))
    .filter((n): n is Note => n !== undefined)
  if (out.length > 0) {
    const rows = out
      .slice(0, EDGE_CAP)
      .map((n) => `  → ${line(n)}${reasons[n.front.id] ? ` — ${reasons[n.front.id]}` : ''}`)
    parts.push(`Links out (${out.length}):\n${rows.join('\n')}${overflow(out.length, EDGE_CAP)}`)
  }
  const incoming = notes.filter((n) => n.front.id !== seedId && n.front.derived_from.includes(seedId))
  if (incoming.length > 0) {
    const rows = incoming
      .slice(0, EDGE_CAP)
      .map((n) => `  ← ${line(n)}${n.front.link_reasons?.[seedId] ? ` — ${n.front.link_reasons[seedId]}` : ''}`)
    parts.push(`Links in (${incoming.length}):\n${rows.join('\n')}${overflow(incoming.length, EDGE_CAP)}`)
  }

  // Lineage — the axis a codebase graph cannot have. Down: what this memory
  // retired. Up: what retired it, ending at the version that speaks today.
  const down: Note[] = []
  let frontier = seed.front.supersedes
  for (let depth = 0; depth < LINEAGE_DEPTH && frontier.length > 0; depth++) {
    const layer = frontier.map((id) => byId.get(id)).filter((n): n is Note => n !== undefined)
    down.push(...layer)
    frontier = layer.flatMap((n) => n.front.supersedes)
  }
  const up: Note[] = []
  let cursor: Note | undefined = seed
  for (let depth = 0; depth < LINEAGE_DEPTH && cursor; depth++) {
    const next: Note | undefined = notes.find((n) => n.front.supersedes.includes(cursor!.front.id))
    if (!next) break
    up.push(next)
    cursor = next
  }
  if (down.length > 0 || up.length > 0) {
    const rows: string[] = []
    for (const n of down.slice(0, EDGE_CAP)) rows.push(`  replaces → ${line(n)}`)
    for (const n of up) rows.push(`  replaced by → ${line(n)}`)
    if (up.length > 0) rows.push(`  (the last one is what speaks today — this note is history)`)
    parts.push(`History:\n${rows.join('\n')}`)
  }

  // The topic this memory belongs to: a hub note wired to it in either
  // direction. Hubs are the librarian's own syntheses, so this is "which
  // chapter of the brain is this page in".
  const hub = notes.find(
    (n) =>
      n.front.type === 'hub' &&
      n.front.status === 'current' &&
      (n.front.derived_from.includes(seedId) || seed.front.derived_from.includes(n.front.id)),
  )
  if (hub) parts.push(`Topic hub: ${line(hub)}`)

  // Folder siblings: memories born in the same place, newest first — the
  // cross-note thread no link ever wrote down.
  if (seed.front.context) {
    const listed = new Set([seedId, ...out.map((n) => n.front.id), ...incoming.map((n) => n.front.id)])
    const siblings = notes
      .filter((n) => n.front.context === seed.front.context && n.front.status === 'current' && !listed.has(n.front.id))
      .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    if (siblings.length > 0) {
      const rows = siblings.slice(0, SIBLING_CAP).map((n) => `  · ${line(n)}`)
      parts.push(
        `Same folder "${seed.front.context}" (${siblings.length} more):\n${rows.join('\n')}${overflow(siblings.length, SIBLING_CAP)}`,
      )
    }
  }

  if (parts.length === 1) {
    parts.push('No connections yet — the librarian links new memories on its next sweeps.')
  }
  return parts.join('\n')
}
