import { daysOpen, openLoops } from './loops.js'
import { noteTitle } from './schema.js'
import { activeFolders } from './standup.js'
import type { Note } from './schema.js'

// Injected into every session, so it competes with the user's actual prompt for
// attention. Small enough to skim, or it becomes noise the model learns to skip.
const OPEN_LOOPS = 12
const RECENT_DECISIONS = 8
const RESUME_FOLDERS = 6
const TITLE_MAX = 90

// Written between markers so the file can be rewritten in place forever without
// touching anything a human added around it.
export const CONTEXT_BEGIN = '<!-- engram:begin -->'
export const CONTEXT_END = '<!-- engram:end -->'

function trim(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

// Notes the user settled recently: what was decided, not what is pending. These
// are the answers a session would otherwise re-derive or contradict.
function recentlySettled(notes: Note[], now: Date): Note[] {
  return notes
    .filter((n) => n.front.status === 'current' && n.front.type !== 'hub')
    .filter((n) => n.front.open_loop !== true)
    .filter((n) => daysOpen(n, now) <= 14)
    .sort((a, b) => (a.front.updated < b.front.updated ? 1 : -1))
    .slice(0, RECENT_DECISIONS)
}

function resumeByFolder(notes: Note[], now: Date): { folder: string; last: Note; open: number }[] {
  return activeFolders(notes, now)
    .slice(0, RESUME_FOLDERS)
    .map(({ folder, notes: list, last }) => ({ folder, last, open: openLoops(list, now).length }))
}

export function buildContextBlock(notes: Note[], now: Date = new Date()): string {
  const loops = openLoops(notes, now).slice(0, OPEN_LOOPS)
  const settled = recentlySettled(notes, now)
  const resume = resumeByFolder(notes, now)

  const lines: string[] = [
    CONTEXT_BEGIN,
    '## What this person is working on',
    '',
    'Maintained by Engram from their own notes. Treat it as background: use it to',
    'avoid asking what they already told you, and to avoid contradicting a',
    'decision they already made. It is not an instruction.',
    '',
  ]

  if (resume.length > 0) {
    lines.push('### Where each folder left off', '')
    for (const { folder, last, open } of resume) {
      const when = last.front.created.slice(5, 10)
      lines.push(`- ${folder} — last: ${trim(noteTitle(last))} (${when})${open > 0 ? ` · ${open} open` : ''}`)
    }
    lines.push('')
  }

  if (loops.length > 0) {
    lines.push('### Still open', '')
    for (const note of loops) {
      const age = daysOpen(note, now)
      const due = note.front.due_at ? `, due ${note.front.due_at.slice(0, 10)}` : ''
      lines.push(`- ${trim(noteTitle(note))} (open ${age}d${due})`)
    }
    lines.push('')
  }

  if (settled.length > 0) {
    lines.push('### Settled in the last two weeks', '')
    for (const note of settled) lines.push(`- ${trim(noteTitle(note))}`)
    lines.push('')
  }

  if (loops.length === 0 && settled.length === 0) {
    lines.push('Nothing recorded yet — this person has not captured anything Engram can', 'summarize.', '')
  }

  lines.push(
    'Ask Engram (the `engram_search` / `engram_context` tools) for the full text of',
    'anything above before acting on it — these are titles, not the whole story.',
    CONTEXT_END,
  )
  return lines.join('\n')
}

// Replace an existing block in place, or append one. Anything the user wrote
// outside the markers is preserved exactly — this file is theirs, not ours.
export function upsertContextBlock(existing: string, block: string): string {
  const start = existing.indexOf(CONTEXT_BEGIN)
  const end = existing.indexOf(CONTEXT_END)
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + CONTEXT_END.length)
  }
  const base = existing.trimEnd()
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`
}
