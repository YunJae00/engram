import { useId } from 'react'

// What Engram may learn from on this computer, each chosen on its own. The
// same list and words at onboarding and in Settings.
export type LearningKey = 'workMap' | 'workFiles' | 'workApps' | 'activity'
export type LearningChoice = Record<LearningKey, boolean>

export const LEARNING_SOURCES: { key: LearningKey; name: string; detail: string }[] = [
  { key: 'workMap', name: 'Browser history, bookmarks and downloads', detail: 'Site names, page titles and downloaded file names from the last 90 days.' },
  { key: 'workFiles', name: 'Recent files and folders', detail: 'Names and locations of files you opened. Contents are not read.' },
  { key: 'workApps', name: 'Apps you use', detail: 'App names and how often you use them.' },
  { key: 'activity', name: 'App activity while Engram is open', detail: 'App names and window titles, kept as an hourly work log.' },
]
export const LEARNING_NOTE = 'Pages and files are never opened. What you allow is saved as notes in your workspace, and your AI reads them to organize Cosmos.'

export function LearningSources({ value, disabled, onChange, testPrefix, compact = false }: { value: LearningChoice; disabled?: boolean; onChange(key: LearningKey, on: boolean): void; testPrefix: string; compact?: boolean }) {
  const note = useId()
  return <fieldset className="learning-sources" aria-describedby={note} data-testid={`${testPrefix}-sources`}>
    <legend>What Engram may learn from</legend>
    {LEARNING_SOURCES.map(source => <label key={source.key} className="learning-source">
      <input type="checkbox" data-testid={`${testPrefix}-source-${source.key}`} checked={value[source.key]} disabled={disabled} onChange={event => onChange(source.key, event.target.checked)} />
      <span><strong>{source.name}</strong>{!compact && <small>{source.detail}</small>}</span>
    </label>)}
    <p className="setting-hint" id={note}>{compact ? 'Names and window titles only, saved as notes and shared with your AI. Pages and file contents are not read.' : LEARNING_NOTE}</p>
    {compact && <details className="learning-details"><summary>Details</summary>{LEARNING_SOURCES.map(source => <p key={source.key}><strong>{source.name}</strong> — {source.detail}</p>)}</details>}
  </fieldset>
}
