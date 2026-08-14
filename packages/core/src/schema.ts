import matter from 'gray-matter'
import { z } from 'zod'

export const NOTE_STATUSES = ['current', 'superseded', 'disputed', 'draft', 'archived'] as const
export const DECAY_LEVELS = ['evergreen', 'slow', 'fast', 'ephemeral'] as const
export const TIMELINE_MODES = ['pinned', 'inferred', 'ignore'] as const

export type NoteStatus = (typeof NOTE_STATUSES)[number]
export type DecayLevel = (typeof DECAY_LEVELS)[number]
export type TimelineMode = (typeof TIMELINE_MODES)[number]

const isoDateTime = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v))
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'invalid date string' })

export const frontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).default('note'),
  status: z.enum(NOTE_STATUSES).default('current'),
  supersedes: z.array(z.string()).default([]),
  derived_from: z.array(z.string()).default([]),
  // Why each derived_from link exists (id → one-line reason from J2). Optional
  // and sparse: legacy links and manual links simply have no entry.
  link_reasons: z.record(z.string()).optional(),
  source: z.string().optional(),
  decay: z.enum(DECAY_LEVELS).default('slow'),
  verified_until: isoDateTime.optional(),
  happened_at: isoDateTime.optional(),
  timeline: z.enum(TIMELINE_MODES).default('inferred'),
  owner: z.string().optional(),
  created: isoDateTime,
  updated: isoDateTime,
  last_recalled: isoDateTime.optional(),
  salience: z.literal('high').optional(),
  triggers: z.array(z.string()).optional(),
  recall_count: z.number().int().nonnegative().optional(),
  warmth: z.object({ w: z.number(), at: isoDateTime }).optional(),
  // Hebbian synapses: co-recalled memories wire together. id → weight + the
  // day it last fired together (weights decay by read-time half-life).
  recall_links: z.record(z.object({ w: z.number(), at: isoDateTime })).optional(),
  open_loop: z.boolean().optional(),
  due_at: isoDateTime.optional(),
  // Who this memory came from, and therefore whose it is to reorganise.
  // Absent means 'user' — every note written before this field existed was a
  // deliberate capture, and treating an unmarked note as the user's is the
  // side to be wrong on. Only J11's session summaries carry 'session', and
  // only those may be merged or superseded without asking (see resolve.ts).
  origin: z.enum(['user', 'session']).optional(),
  // WHERE the memory came from — the folder name of the session it was
  // harvested in ("strata", "novel", "q3-report"). Generic on purpose: a note
  // titled "Team" is unreadable without the one word saying which world's
  // Team it is, and that word was always known and previously dropped.
  context: z.string().optional(),
})

export type NoteFrontmatter = z.infer<typeof frontmatterSchema>

export interface Note {
  front: NoteFrontmatter
  body: string
}

export function parseNote(markdown: string): Note {
  const { data, content } = matter(markdown)
  const front = frontmatterSchema.parse(data)
  return { front, body: content.replace(/^\n/, '') }
}

// Serialization keeps a stable key order so round-trips produce identical files.
const KEY_ORDER: (keyof NoteFrontmatter)[] = [
  'id',
  'type',
  'status',
  'supersedes',
  'derived_from',
  'link_reasons',
  'source',
  'decay',
  'verified_until',
  'happened_at',
  'timeline',
  'owner',
  'created',
  'updated',
  'last_recalled',
  'recall_count',
  'warmth',
  'salience',
  'triggers',
  'recall_links',
  'open_loop',
  'due_at',
  'origin',
  'context',
]

// A field missing from KEY_ORDER is silently dropped by serializeNote — it
// parses, it type-checks, it round-trips in memory, and it is simply not there
// after a write. `origin` was added to the schema and forgotten here, and the
// only thing that caught it was a test asserting the feature actually fired.
// Pin the two lists together so the next field cannot fail the same quiet way.
const SCHEMA_KEYS = Object.keys(frontmatterSchema.shape) as (keyof NoteFrontmatter)[]
const UNSERIALISED = SCHEMA_KEYS.filter((key) => !KEY_ORDER.includes(key))
if (UNSERIALISED.length > 0) {
  throw new Error(`frontmatter fields missing from KEY_ORDER (they would never be written): ${UNSERIALISED.join(', ')}`)
}

export function serializeNote(note: Note): string {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    const value = note.front[key]
    if (value === undefined) continue
    ordered[key] = value
  }
  return matter.stringify(note.body.endsWith('\n') ? note.body : note.body + '\n', ordered)
}

// First markdown heading (or first non-empty line) stands in for a title;
// the schema deliberately has no title field.
export function noteTitle(note: Note): string {
  for (const line of note.body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    return trimmed.replace(/^#+\s*/, '')
  }
  return note.front.id
}
