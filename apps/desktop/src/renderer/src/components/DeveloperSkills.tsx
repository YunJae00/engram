import { useEffect, useId, useState, type RefObject } from 'react'
import type { DevCommand, DevProvider } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'

export function DeveloperSkills({ session, repoId, provider, query, input, onSelect, onDismiss }: { session?: string; repoId: string; provider: DevProvider; query: string; input: RefObject<HTMLTextAreaElement | null>; onSelect(prompt: string): void; onDismiss(): void }) {
  const id = useId(), [rows, setRows] = useState<DevCommand[] | null>(null), [error, setError] = useState(''), [selected, setSelected] = useState(0)
  useEffect(() => {
    let alive = true
    setRows(null); setError('')
    void (session ? api.devCommands(session) : api.devProjectCommands(repoId, provider)).then(value => { if (alive) setRows(value) }).catch(error => { if (alive) setError(apiErrorText(error.message)) })
    return () => { alive = false }
  }, [session, repoId, provider])
  const matches = rows?.filter(row => row.name.toLowerCase().includes(query.toLowerCase())) ?? []
  const index = Math.min(selected, Math.max(0, matches.length - 1))
  useEffect(() => {
    const node = input.current
    if (!node) return
    const key = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) || event.isComposing) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') onDismiss()
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, matches.length)) % Math.max(1, matches.length))
      else if (matches[index]) onSelect(matches[index]!.prompt)
    }
    node.setAttribute('aria-controls', id); node.setAttribute('aria-expanded', 'true')
    if (matches.length) node.setAttribute('aria-activedescendant', `${id}-${index}`)
    node.addEventListener('keydown', key)
    return () => { node.removeEventListener('keydown', key); for (const attr of ['aria-controls', 'aria-expanded', 'aria-activedescendant']) node.removeAttribute(attr) }
  }, [input, id, index, matches, onSelect, onDismiss])
  return <div className="dev-skills" id={id} role="listbox" aria-label="Skills">
    {error ? <p role="status">{error}</p> : !rows ? <p role="status">Loading skills…</p> : !matches.length ? <p role="status">No matching skills.</p> : matches.map((row, at) => <button id={`${id}-${at}`} key={row.name} role="option" aria-selected={index === at} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(row.prompt)}><strong>/{row.name}</strong><small>{row.description}</small></button>)}
  </div>
}
