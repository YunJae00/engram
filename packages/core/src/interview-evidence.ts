import { createHash } from 'node:crypto'
import { freshnessOf } from './freshness.js'
import type { Note } from './schema.js'
import { withoutSecrets } from './secrets.js'
import type { Playbook } from './task-playbooks.js'
import { placeNoteId, type WorkMap } from './work-map.js'

export interface InterviewSource {
  id: string
  kind: 'task' | 'place' | 'guide'
  label: string
  grounding: {
    completedCount?: number
    visitDays?: number
    lastSeen?: string
    bookmark?: 'personal' | 'managed' | 'none'
    workClassification?: 'inferred'
    hosts?: string[]
    guideStatement?: string
  }
}

export interface InterviewEvidence {
  sources?: InterviewSource[]
  guide?: string
  context?: {
    source: string
    note: string
    updated: string
    relation: 'place' | 'host' | 'task' | 'link'
    provenance: 'observed-reference' | 'inferred-link'
    excerpt: string
  }[]
  // Legacy metadata is accepted, but it cannot make a question eligible.
  files?: string[]
  places?: string[]
  facts?: string[]
}

export const INTERVIEW_SOURCE_ID = /^(?:task|place|guide)-[a-f0-9]{24}$/
const SOURCE_LIMIT = 8
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
const sourceId = (kind: InterviewSource['kind'], key: string) => `${kind}-${createHash('sha256').update(normalize(key)).digest('hex').slice(0, 24)}`
const quotedPath = /(["'`])(?:[a-z]:[\\/]|\\\\|~?\/)[^\r\n]*?\1/gi
const spacedFile = /(?:[a-z]:[\\/]|\\\\|(?:^|\s)~?\/)[^\r\n<>"'`?*|]+?\.[a-z0-9]{1,8}(?=$|[\s,;.!?"'`])/gi
const localPath = /(?:[a-z]:[\\/]|\\\\|(?:^|\s)~?\/|\b(?:Desktop|Documents|Downloads)[\\/])[^\s<>"']+/gi
const relativeFile = /\b[\p{L}\p{N}_.~-]+(?:[\\/][\p{L}\p{N}_.~ -]+)+\.[a-z0-9]{1,8}\b/giu

// Only hostnames leave this module; URL paths and local paths add no evidence of relevance.
export const interviewText = (value: string, max: number): string => value
  .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { return new URL(raw).hostname } catch { return '' }
  }).replace(quotedPath, '').replace(spacedFile, '').replace(localPath, '').replace(relativeFile, '').replace(/\s+/g, ' ').trim().slice(0, max)

export function hasInterviewPath(value: string): boolean {
  return new RegExp(localPath.source, 'iu').test(value) || new RegExp(relativeFile.source, 'iu').test(value) || /https?:\/\/|(?:^|\s)[\p{L}\p{N}_.~-]+[\\/][\p{L}\p{N}_.~-]+[\\/]/iu.test(value)
}

function host(raw: string): string | undefined {
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.hostname.toLowerCase() : undefined
  } catch { return undefined }
}

export function selectInterviewEvidence({ map, playbooks = [], guide = '', notes = [], excludedIds = [], now = new Date() }: {
  map?: WorkMap | null
  playbooks?: Playbook[]
  guide?: string
  notes?: readonly Note[]
  excludedIds?: readonly string[]
  now?: Date
}): InterviewEvidence & { sources: InterviewSource[] } {
  guide = typeof guide === 'string' ? guide : ''
  const excluded = new Set(excludedIds)
  const candidates = new Map<string, { source: InterviewSource; tier: number; score: number }>()
  const age = (at: string) => (now.getTime() - Date.parse(at)) / 86_400_000
  const add = (source: InterviewSource, tier: number, score: number) => {
    if (excluded.has(source.id) || !source.label) return
    const previous = candidates.get(source.id)
    if (!previous || previous.score < score) candidates.set(source.id, { source, tier, score })
  }
  for (const one of Array.isArray(playbooks) ? playbooks : []) {
    if (!one || typeof one.at !== 'string' || typeof one.goal !== 'string') continue
    const daysAgo = age(one.at)
    if (!Number.isFinite(daysAgo) || daysAgo < -1 || !one.goal?.trim()) continue
    const count = Number.isInteger(one.count) && one.count! > 0 ? one.count! : 1
    const label = interviewText(one.goal, 180)
    if (!label) continue
    add({ id: sourceId('task', one.goal), kind: 'task', label, grounding: {
      completedCount: count, lastSeen: one.at,
      hosts: [...new Set((Array.isArray(one.urls) ? one.urls : []).filter((url): url is string => typeof url === 'string').map(host).filter((one): one is string => !!one))].slice(0, 3),
    } }, 0, count / (1 + Math.max(0, daysAgo) / 30))
  }
  // Most guide sections are settled constraints. Only explicitly listed work can suggest a task to ask about.
  let recurring = false
  const statements = guide.split('\n').flatMap(line => {
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) { recurring = heading[1]!.trim() === 'Recurring work'; return [] }
    return recurring && line.trim() ? [interviewText(line.replace(/^\s*[-*]\s+/, ''), 400)] : []
  })
  for (const statement of statements.filter(Boolean)) add({
    id: sourceId('guide', statement), kind: 'guide', label: statement.slice(0, 180), grounding: { guideStatement: statement },
  }, 1, 0)
  const taskHosts = new Set([...candidates.values()].flatMap(one => one.source.grounding.hosts ?? []))
  for (const place of Array.isArray(map?.places) ? map.places : []) {
    if (!place || typeof place.host !== 'string' || typeof place.lastSeen !== 'string') continue
    const daysAgo = age(place.lastSeen)
    const name = host(place.host)
    // Classification is a model inference. Repeated recent use corroborates it; bookmarks alone do not.
    if (!name || taskHosts.has(name) || place.work !== true || !Number.isInteger(place.days) || place.days < 3 || !Number.isFinite(daysAgo) || daysAgo < -1 || daysAgo > 30) continue
    const label = interviewText(typeof place.purpose === 'string' && place.purpose.trim() ? place.purpose : typeof place.title === 'string' ? place.title : '', 180)
    if (!label || normalize(label) === name) continue
    add({ id: sourceId('place', name), kind: 'place', label, grounding: {
      hosts: [name], visitDays: place.days, lastSeen: place.lastSeen, workClassification: 'inferred',
      bookmark: Array.isArray(place.bookmarks) && place.bookmarks.length ? place.managed === true ? 'managed' : 'personal' : 'none',
    } }, 2, place.days / (1 + Math.max(0, daysAgo) / 7))
  }
  const ordered = [...candidates.values()].sort((a, b) => a.tier - b.tier || b.score - a.score || a.source.id.localeCompare(b.source.id))
  const sources = ordered.slice(0, SOURCE_LIMIT).map(one => one.source)
  // Explicitly listed rare work must not disappear behind frequent task history.
  const known = ordered.find(one => one.source.kind === 'guide')?.source
  if (known && !sources.some(one => one.id === known.id)) sources[sources.length - 1] = known
  const context = relatedNotes(sources, notes, now)
  return { sources, ...(guide.trim() ? { guide: interviewText(guide, 12000) } : {}), ...(context.length ? { context } : {}) }
}

// Notes enrich existing evidence; neither a filename nor a summary can establish a person's work.
function relatedNotes(sources: InterviewSource[], notes: readonly Note[], now: Date): NonNullable<InterviewEvidence['context']> {
  const current = notes.filter(note => note.front.status === 'current'
    && !['guide', 'profile'].includes(note.front.type)
    && /^[\p{L}\p{N}_-]{1,100}$/u.test(note.front.id)
    && Number.isFinite(Date.parse(note.front.updated)) && Date.parse(note.front.updated) <= now.getTime() + 86_400_000
    && freshnessOf(note, now) !== 'stale')
  const result: NonNullable<InterviewEvidence['context']> = []
  const used = new Set<string>()
  for (const source of sources) {
    const hosts = new Set(source.grounding.hosts ?? [])
    const places = new Set([...hosts].map(placeNoteId))
    const direct = new Map<string, 'place' | 'host' | 'task'>()
    for (const note of current) {
      if (note.front.type === 'place' && places.has(note.front.id)) direct.set(note.front.id, 'place')
      else if (source.kind === 'task' && (note.front.source === source.id || note.front.derived_from.includes(source.id))) direct.set(note.front.id, 'task')
      else {
        const urls = `${note.front.source ?? ''}\n${note.body.slice(0, 16000)}`.match(/https?:\/\/[^\s<>"'\])]+/gi) ?? []
        if (urls.some(url => { const name = host(url); return !!name && hosts.has(name) })) direct.set(note.front.id, 'host')
      }
    }
    // A single stored graph edge may add context, not certainty; never expand links recursively.
    const anchors = new Set([...places, ...direct.keys()])
    const outward = new Set(current.filter(note => direct.has(note.front.id)).flatMap(note => note.front.derived_from))
    const matched = current.flatMap(note => {
      const relation = direct.get(note.front.id) ?? (note.front.derived_from.some(id => anchors.has(id)) || outward.has(note.front.id) ? 'link' as const : undefined)
      return relation ? [{ note, relation }] : []
    }).sort((a, b) => Number(a.relation === 'link') - Number(b.relation === 'link') || Date.parse(b.note.front.updated) - Date.parse(a.note.front.updated) || a.note.front.id.localeCompare(b.note.front.id))
    let count = 0
    for (const { note, relation } of matched) {
      if (used.has(note.front.id)) continue
      const excerpt = interviewText(withoutSecrets(note.body.slice(0, 16000), note.body.slice(0, 16000)), 600)
      if (!excerpt) continue
      used.add(note.front.id)
      result.push({ source: source.id, note: note.front.id, updated: note.front.updated, relation,
        provenance: relation === 'link' ? 'inferred-link' : 'observed-reference', excerpt })
      if (result.length === 6) return result
      if (++count === 2) break
    }
  }
  return result
}
