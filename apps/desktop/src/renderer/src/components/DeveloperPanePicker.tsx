import { useState } from 'react'
import { Check, ChevronDown, Folder, Plus } from 'lucide-react'
import type { DevState } from '../../../shared/developers.js'
import { DeveloperPopover } from './DeveloperControls.js'
import { ProviderIcon } from './ProviderIcon.js'

export function DeveloperPanePicker({ title, current, state, onChoose }: { title: string; current?: string; state: DevState; onChoose(id: string | undefined, repo: string): void }) {
  const [query, setQuery] = useState('')
  return <DeveloperPopover label="Choose conversation for this pane" trigger={<><span>{title}</span><ChevronDown size={13} /></>}>
    {close => <div className="dev-pane-picker"><input type="search" aria-label="Search project sessions" placeholder="Find a conversation…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="dev-pane-picker-list">{state.repos.map(repo => {
        const sessions = state.sessions.filter(session => session.repoId === repo.id && `${repo.name} ${session.title}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt)
        if (query && !sessions.length && !repo.name.toLowerCase().includes(query.toLowerCase())) return null
        return <section key={repo.id}><h3 title={repo.path}><Folder size={13} />{repo.name}</h3><button className="dev-menu-row" onClick={() => { close(); onChoose(undefined, repo.id) }}><Plus size={14} /><span>New session</span></button>{sessions.map(session => <button key={session.id} className="dev-menu-row" aria-current={current === session.id ? 'true' : undefined} onClick={() => { close(); onChoose(session.id, repo.id) }}><ProviderIcon provider={session.provider} size={14} /><span>{session.title}</span>{current === session.id && <Check size={14} />}</button>)}</section>
      })}{query && !state.repos.some(repo => repo.name.toLowerCase().includes(query.toLowerCase())) && !state.sessions.some(session => session.title.toLowerCase().includes(query.toLowerCase())) && <p>No matching conversations.</p>}</div>
    </div>}
  </DeveloperPopover>
}
