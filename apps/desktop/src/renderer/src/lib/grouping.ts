import { BookOpen, CalendarDays, CircleHelp, FileDown, Gavel, Info, Lightbulb, Library, ListChecks, Network, Package, StickyNote, Users, Wrench, type LucideIcon } from 'lucide-react'
import type { StringKey } from '../i18n.js'

// Note-identity helpers shared across the shell (list rows, topic pages, the
// palette, the capture echo). Pure functions — no React, no IPC — so every
// caller stays thin and the logic is unit-testable on its own.

// ── Note identity: one source for every note type's icon, label and tone ──
// The list rows, memory rows, hover surfaces and the help legend all read
// their glyph/tone from here so a type never disagrees with itself across
// the UI.
type Tone = 'accent' | 'teal' | 'gild' | 'clay' | 'none'

interface TypeIdentity {
  icon: LucideIcon
  labelKey: StringKey
  tone: Tone
}

export function typeIdentity(type: string): TypeIdentity {
  switch (type) {
    case 'decision':
      return { icon: Gavel, labelKey: 'type.decision', tone: 'accent' }
    case 'concept':
      return { icon: BookOpen, labelKey: 'type.concept', tone: 'teal' }
    case 'howto':
      return { icon: ListChecks, labelKey: 'type.howto', tone: 'gild' }
    case 'troubleshooting':
      return { icon: Wrench, labelKey: 'type.troubleshooting', tone: 'clay' }
    case 'log':
      return { icon: CalendarDays, labelKey: 'type.log', tone: 'none' }
    case 'event':
      return { icon: CalendarDays, labelKey: 'type.event', tone: 'none' }
    case 'fact':
      return { icon: Info, labelKey: 'type.fact', tone: 'teal' }
    case 'question':
      return { icon: CircleHelp, labelKey: 'type.question', tone: 'gild' }
    case 'imported':
      return { icon: FileDown, labelKey: 'type.imported', tone: 'none' }
    case 'artifact':
      // Chat answers promoted to notes (Record) — a distinct, teal "made thing".
      return { icon: Package, labelKey: 'type.artifact', tone: 'teal' }
    case 'hub':
      // J9's topic syntheses — the librarian's "what this pile amounts to".
      return { icon: Network, labelKey: 'type.hub', tone: 'accent' }
    // The AGENTS.md taxonomy (fact/decision/meeting/idea/reference) — these
    // three used to fall through to the generic note identity, which left
    // folders labelled with the raw English type key.
    case 'meeting':
      return { icon: Users, labelKey: 'type.meeting', tone: 'none' }
    case 'idea':
      return { icon: Lightbulb, labelKey: 'type.idea', tone: 'gild' }
    case 'reference':
      return { icon: Library, labelKey: 'type.reference', tone: 'teal' }
    default:
      return { icon: StickyNote, labelKey: 'type.note', tone: 'none' }
  }
}

// Freshness tone for the flat freshness dot; disputed/unknown badges show no
// dot (the conflict flag carries that state instead). Single-sourced here so
// the list rows, memory rows, palette, capture echo and cosmos stars all paint
// the same dot.
export function freshTone(badge: string): 'green' | 'amber' | 'red' | null {
  if (badge === '🟢') return 'green'
  if (badge === '🟡') return 'amber'
  if (badge === '🔴') return 'red'
  return null
}

// YYYY.MM.DD from an ISO date/datetime string (date part only, no timezone math).
export function ymd(iso: string | undefined): string {
  if (!iso) return ''
  return iso.slice(0, 10).replace(/-/g, '.')
}

// Strip pictographic emoji (plus their variation selectors and ZWJ joiners) from
// a string so titles/excerpts read as clean paper. Newlines survive; only runs
// of spaces collapse. NoteSheet keeps the raw text — only surfaces that quote a
// note into a row or label call this.
export function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[︀-️‍]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
