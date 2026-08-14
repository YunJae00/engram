import { createHash } from 'node:crypto'
import { extractJson } from '../engine/types.js'
import { createNote, readNote, writeNote } from '../notes.js'
import type { SemanticEdge } from '../neighbors.js'
import type { Note } from '../schema.js'
import { noteTitle } from '../schema.js'
import type { VaultPaths } from '../vault.js'
import { topicComponents } from './graph.js'
import { mergeBySubject, type SubjectKnowledge } from './subject.js'
import { withPrompt } from './prompts.js'
import type { JobSpec } from './runner.js'

const digest = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)

// A component this small reads fine as loose cards; synthesis starts paying
// off at 4 notes.
const HUB_MIN_NOTES = 4
// Hub synthesis is a judgment job over up to this many member notes; larger
// components send their most recently updated members.
const HUB_MAX_MEMBERS = 12

// One topic as J9 sees it: the notes, plus the subject that merged two
// communities into it (null when the graph found it whole).
interface Topic {
  members: Note[]
  subject: string | null
}

export function linkComponents(notes: Note[], known: SubjectKnowledge = {}, fabric: SemanticEdge[] = []): Topic[] {
  const eligible = notes.filter((n) => n.front.status === 'current' && n.front.type !== 'hub')
  const byId = new Map(eligible.map((n) => [n.front.id, n]))
  const adjacent = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b)) return
    if (!adjacent.has(a)) adjacent.set(a, new Set())
    if (!adjacent.has(b)) adjacent.set(b, new Set())
    adjacent.get(a)!.add(b)
    adjacent.get(b)!.add(a)
  }
  for (const note of eligible) {
    for (const rel of note.front.derived_from) link(note.front.id, rel)
  }
  for (const edge of fabric) link(edge.a, edge.b)
  // topicComponents cuts multi-topic bridge notes (the mega-hub fix) — a
  // weekly review linking into three topics must not weld them into one — and
  // mergeBySubject puts back the ones that were only ever split by link
  // density. The merge runs BEFORE the size filter so two same-subject
  // communities of three become one topic of six that earns a hub, instead of
  // both falling under HUB_MIN_NOTES and getting none.
  return mergeBySubject(topicComponents(adjacent), (id) => noteTitle(byId.get(id)!), adjacent, known)
    .filter((topic) => topic.ids.length >= HUB_MIN_NOTES)
    .map((topic) => ({ members: topic.ids.map((id) => byId.get(id)!), subject: topic.subject }))
}

// The existing hub for a component, if any: the current hub note sharing the
// most members (at least 2 — one shared id is coincidence, not identity).
//
// `taken` is what stops one hub from being claimed twice. When a topic splits,
// every part still overlaps the old topic's hub — without this both parts
// would be handed the same hub note and their J9 jobs would overwrite each
// other's synthesis, leaving one topic silently unlabelled. Components are
// offered hubs largest-first, so the biggest heir keeps the old name and the
// rest get fresh ones. MIRRORED as matchTopicHub in the renderer's
// lib/topics.ts — keep the two in lockstep.
export function matchHub(hubs: Note[], members: Note[], taken: ReadonlySet<string> = new Set()): Note | null {
  const ids = new Set(members.map((n) => n.front.id))
  let best: Note | null = null
  let bestOverlap = 1
  for (const hub of hubs) {
    if (taken.has(hub.front.id)) continue
    const overlap = hub.front.derived_from.filter((id) => ids.has(id)).length
    if (overlap > bestOverlap) {
      best = hub
      bestOverlap = overlap
    }
  }
  return best
}

// Does this hub still describe this exact pile? A hub is written FOR a member
// set and records it in derived_from, so anything else means the topic has been
// redefined underneath it and its title is naming something that is gone.
function hubCoversTopic(hub: Note | null, memberIds: readonly string[]): boolean {
  if (!hub || hub.front.derived_from.length !== memberIds.length) return false
  const ids = new Set(memberIds)
  return hub.front.derived_from.every((id) => ids.has(id))
}

// A refusal/apology or a pointer is not a hub body. Shape check only.
function isHubBody(text: string | undefined): boolean {
  const t = (text ?? '').trim()
  return t.startsWith('#') && t.length >= 40
}

export function buildJ9(
  paths: VaultPaths,
  agentsMd: string,
  members: Note[],
  existingHub: Note | null,
  now: Date,
  subject: string | null = null,
): JobSpec {
  const recent = [...members]
    .sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))
    .slice(0, HUB_MAX_MEMBERS)
  const memberIds = members.map((n) => n.front.id).sort()
  const sameTopic = hubCoversTopic(existingHub, memberIds)
  // Input identity = who is in the topic + what state they were in; a sweep
  // that changed nothing skips via the journal.
  const inputKey = digest(`${memberIds.join(',')}|${members.map((n) => n.front.updated).sort().join(',')}`)
  return {
    kind: 'J9',
    disallowTools: true,
    modelHint: 'default', // synthesis is a judgment job — pointer bullets from a cheap model are worthless
    inputKey,
    ...withPrompt(
      agentsMd,
      'J9',
      [
        'Below is a cluster of notes connected into one topic. Write the body of this topic\u2019s hub note in markdown, in the language of the notes.',
        'Line 1 is "# <topic name>" — a short 2-5 word name for the whole subject. No colons, no subtitle, no summary sentence; the detail belongs in the bullets.',
        'Name the topic from the notes actually in this cluster right now. When no existing_hub is given, the cluster boundary has moved and any previous name is void.',
        'When `subject` is given, it is the thread running through the whole cluster — reflect it in the name.',
        'Then synthesize what the cluster as a whole says in 3-6 bullets: the conclusions, the current state, the open questions. Never a list of titles.',
        'End with a "## Notes" section listing each note as "- <title> (<id>)".',
        'Output only JSON {"body":"..."}.',
      ].join('\n'),
      {
        notes: recent.map((n) => ({ id: n.front.id, title: noteTitle(n), excerpt: n.body.slice(0, 300) })),
        subject: subject ?? undefined,
        existing_hub:
          sameTopic && existingHub ? { id: existingHub.front.id, body: existingHub.body.slice(0, 600) } : undefined,
      },
    ),
    async apply(result) {
      const parsed = extractJson(result) as { body?: string }
      if (!isHubBody(parsed.body)) return ['ignored: hub body too thin']
      const body = parsed.body!.trim()
      if (existingHub) {
        const hub = await readNote(paths, existingHub.front.id)
        hub.body = body
        hub.front.derived_from = memberIds
        hub.front.updated = now.toISOString()
        await writeNote(paths, hub)
        return [`hub updated: ${hub.front.id} (${memberIds.length} notes)`]
      }
      const hub = await createNote(paths, { body, type: 'hub', decay: 'slow', derived_from: memberIds }, now)
      return [`hub created: ${hub.front.id} (${memberIds.length} notes)`]
    },
  }
}

// This sweep's J9 batch: at most `cap` syntheses, spent on the topics that
// still have no name of their own.
export function planHubJobs(
  paths: VaultPaths,
  agentsMd: string,
  notes: Note[],
  now: Date,
  cap: number,
  known: SubjectKnowledge = {},
  fabric: SemanticEdge[] = [],
): JobSpec[] {
  const topics = linkComponents(notes, known, fabric)
  if (topics.length === 0) return []
  const hubs = notes.filter((n) => n.front.type === 'hub' && n.front.status === 'current')
  // One hub per topic: claimed hubs are off the table for later topics (see
  // matchHub) so a split topic cannot have two parts writing to the same hub
  // note. Matching runs over EVERY topic, largest first, BEFORE the cap picks
  // jobs — otherwise a smaller topic queued first could take the hub its bigger
  // heir should keep.
  const taken = new Set<string>()
  const paired = topics.map(({ members, subject }, rank) => {
    const hub = matchHub(hubs, members, taken)
    if (hub) taken.add(hub.front.id)
    return { members, subject, hub, rank, named: hubCoversTopic(hub, members.map((n) => n.front.id)) }
  })
  return paired
    .sort((a, b) => Number(a.named) - Number(b.named) || a.rank - b.rank)
    .slice(0, cap)
    .map((topic) => buildJ9(paths, agentsMd, topic.members, topic.hub, now, topic.subject))
}
