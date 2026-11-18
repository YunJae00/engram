import { BookOpen, CalendarDays, CircleHelp, FileDown, Gavel, Info, Lightbulb, Library, ListChecks, Network, Package, StickyNote, Users, Wrench, type LucideIcon } from 'lucide-react'
import type { StringKey } from '../i18n.js'

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
      return { icon: Package, labelKey: 'type.artifact', tone: 'teal' }
    case 'hub':
      return { icon: Network, labelKey: 'type.hub', tone: 'accent' }
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

export function freshTone(badge: string): 'green' | 'amber' | 'red' | null {
  if (badge === '🟢') return 'green'
  if (badge === '🟡') return 'amber'
  if (badge === '🔴') return 'red'
  return null
}

export function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[︀-️‍]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
