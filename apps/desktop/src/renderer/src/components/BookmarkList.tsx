import { Folder } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { BookmarkDto } from '../../../shared/types.js'

export function BookmarkList({ rows, search, onOpen }: { rows: BookmarkDto[]; search: string; onOpen(url: string): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const link = (row: BookmarkDto, index: number) => <button key={`${row.sourceId}:${row.folder}:${row.url}:${index}`} title={`${row.sourceName ?? 'Previously imported'} / ${row.folder}\n${row.url}`} onClick={() => onOpen(row.url)}><span>{row.title}</span><small>{search ? `${row.sourceName ?? 'Previously imported'} · ${row.folder || new URL(row.url).hostname}` : new URL(row.url).hostname}</small></button>
  if (search) return <>{rows.slice(0, 150).map(link)}{rows.length > 150 && <p>Refine your search to see more.</p>}</>
  const tree = (items: BookmarkDto[], path: string[], depth = 0): ReactNode => {
    const folders = new Map<string, BookmarkDto[]>()
    const direct: BookmarkDto[] = []
    for (const row of items) {
      const folder = (row.folderPath ?? (row.folder ? [row.folder] : []))[depth]
      if (!folder) direct.push(row)
      else { if (!folders.has(folder)) folders.set(folder, []); folders.get(folder)!.push(row) }
    }
    return <>{direct.map(link)}{[...folders].map(([name, contents]) => {
      const key = JSON.stringify([...path, name])
      const open = expanded.has(key)
      return <details className="bookmark-folder" key={name} open={open} onToggle={event => { const value = event.currentTarget.open; setExpanded(previous => { if (previous.has(key) === value) return previous; const next = new Set(previous); if (value) next.add(key); else next.delete(key); return next }) }}><summary><Folder size={14} aria-hidden /><span>{name}</span><small>{contents.length}</small></summary>{open && <div>{tree(contents, [...path, name], depth + 1)}</div>}</details>
    })}</>
  }
  const sources = new Map<string, { name: string; rows: BookmarkDto[] }>()
  for (const row of rows) {
    const id = row.sourceId ?? 'legacy'
    if (!sources.has(id)) sources.set(id, { name: row.sourceName ?? 'Previously imported', rows: [] })
    sources.get(id)!.rows.push(row)
  }
  return <>{[...sources].map(([id, source]) => <section className="bookmark-source" key={id} aria-label={source.name}><h3>{source.name}<small>{source.rows.length}</small></h3>{tree(source.rows, [id])}</section>)}</>
}
