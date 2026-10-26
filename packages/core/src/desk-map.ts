import { posix, win32 } from 'node:path'
import type { Note } from './schema.js'

// What this computer already records about the person's work outside the
// browser: the files they opened, the apps they use, and the files they
// downloaded. Names and counts only; no file is opened. Each source is its
// own note, written only while the person allows that source.

export const DESK_TYPE = 'desk'
export const DESK_NOTES = { files: 'n-desk-files', apps: 'n-desk-apps', downloads: 'n-desk-dloads' } as const
export const DESK_WINDOW_DAYS = 30

export interface RecentFile { path: string; at: number }
export interface AppUse { name: string; runs: number; focusMs: number; lastRun?: number }
export interface Download { file: string; host: string; at: number }

const OWN = '## Your notes'
const day = (at: number) => new Date(at).toISOString().slice(0, 10)
const filePath = (path: string) => /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? win32 : posix

function deskNote(id: string, generated: string[], source: string, now: Date, existing?: Note | null): Note {
  const stamp = now.toISOString()
  const own = existing?.body.includes(OWN) ? existing.body.slice(existing.body.indexOf(OWN)) : `${OWN}\n\nAdd what these mean for your work. Lines above this section are refreshed from this computer.\n`
  const body = [...generated, '', `_${source} on ${stamp.slice(0, 10)}. Names only; nothing was opened._`].join('\n')
  return {
    front: existing?.front
      ? { ...existing.front, updated: stamp }
      : { id, type: DESK_TYPE, status: 'current', supersedes: [], derived_from: [], decay: 'fast', timeline: 'ignore', created: stamp, updated: stamp },
    body: `${body}\n\n${own}`,
  }
}

export function filesNote(files: RecentFile[], now: Date, existing?: Note | null): Note | null {
  if (!files.length) return null
  const folders = new Map<string, RecentFile[]>()
  for (const file of files) {
    const folder = filePath(file.path).dirname(file.path)
    folders.set(folder, [...folders.get(folder) ?? [], file])
  }
  const ranked = [...folders].sort((a, b) => b[1].length - a[1].length || Math.max(...b[1].map(f => f.at)) - Math.max(...a[1].map(f => f.at))).slice(0, 12)
  const recent = [...files].sort((a, b) => b.at - a.at).slice(0, 20)
  return deskNote(DESK_NOTES.files, [
    '# Files you work with',
    '',
    `Folders used most in the last ${DESK_WINDOW_DAYS} days:`,
    ...ranked.map(([folder, list]) => `- ${folder}: ${list.length} file${list.length === 1 ? '' : 's'}, such as ${list.slice(0, 3).map(f => filePath(f.path).basename(f.path)).join(', ')}`),
    '',
    'Opened most recently:',
    ...recent.map(file => `- ${filePath(file.path).basename(file.path)} (${day(file.at)})`),
  ], "Learned from this computer's recent items", now, existing)
}

export function appsNote(apps: AppUse[], now: Date, existing?: Note | null): Note | null {
  const used = apps.filter(app => app.runs > 0 || app.focusMs > 0).slice(0, 20)
  if (!used.length) return null
  return deskNote(DESK_NOTES.apps, [
    '# Apps you use',
    '',
    ...used.map(app => `- ${app.name}: opened ${app.runs} time${app.runs === 1 ? '' : 's'}${app.focusMs >= 60_000 ? `, about ${Math.round(app.focusMs / 3_600_000 * 10) / 10} h in front` : ''}${app.lastRun ? `, last on ${day(app.lastRun)}` : ''}`),
  ], "Learned from this computer's app usage record", now, existing)
}

export function downloadsNote(downloads: Download[], now: Date, existing?: Note | null): Note | null {
  if (!downloads.length) return null
  const hosts = new Map<string, Download[]>()
  for (const item of downloads) hosts.set(item.host, [...hosts.get(item.host) ?? [], item])
  const ranked = [...hosts].sort((a, b) => b[1].length - a[1].length).slice(0, 15)
  return deskNote(DESK_NOTES.downloads, [
    '# Files downloaded for work',
    '',
    ...ranked.map(([host, list]) => {
      const sorted = [...list].sort((a, b) => b.at - a.at)
      return `- ${host}: ${list.length} file${list.length === 1 ? '' : 's'}, such as ${[...new Set(sorted.map(item => item.file))].slice(0, 4).join(', ')}; last on ${day(sorted[0]!.at)}`
    }),
  ], "Learned from this computer's browser download history", now, existing)
}

const rot13 = (text: string) => text.replace(/[a-z]/gi, ch => String.fromCharCode((ch <= 'Z' ? 65 : 97) + (ch.toLowerCase().charCodeAt(0) - 97 + 13) % 26))
const FILETIME_EPOCH_MS = 11_644_473_600_000

// A readable app name from a recorded path or app id. Paths name their
// program; dotted app ids name it in their most specific segment, except a
// browser profile id, which names its browser first.
const GENERIC = new Set(['com', 'dev', 'org', 'net', 'app', 'apps', 'electron', 'microsoft', 'client', 'exe'])
export function appLabel(recorded: string): string {
  if (/[\\/]/.test(recorded)) return (recorded.split(/[\\/]/).pop() ?? recorded).replace(/\.(exe|lnk)$/i, '')
  const exe = /([^.]+)\.exe(?:\.\d+)?$/i.exec(recorded)
  if (exe) return exe[1]!
  const parts = recorded.replace(/!.*$/, '').replace(/_[a-z0-9]{13}$/i, '').split('.')
  if (parts.length > 1 && /^(Default|Profile \d+)$/.test(parts.at(-1)!)) return parts[0]!
  return parts.filter(part => !GENERIC.has(part.toLowerCase()) && !/^\d+$/.test(part)).pop() ?? recorded
}
// Installers and the operating system's own shell are not the person's work.
const NOT_WORK = /^UEME_|AutoGenerated|Shell\.RunDialog|^Microsoft\.?Windows|ExperienceHost|LockApp|SystemProfile|setup|install|updater|uninst/i

// The Windows app usage record (UserAssist) as `reg query /s` prints it:
// value names are ROT13, data is a 72-byte record with the run count at 4,
// time in front at 12 and the last run (FILETIME) at 60.
export function parseUserAssist(output: string): AppUse[] {
  const merged = new Map<string, AppUse>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{4}REG_BINARY\s{4}([0-9A-Fa-f]*)\s*$/.exec(line)
    if (!match || match[2]!.length < 144) continue
    const recorded = rot13(match[1]!)
    if (NOT_WORK.test(recorded)) continue
    const data = Buffer.from(match[2]!, 'hex')
    const runs = data.readUInt32LE(4), focusMs = data.readUInt32LE(12), filetime = data.readBigUInt64LE(60)
    if (!runs && !focusMs) continue
    const lastRun = filetime > 0n ? Number(filetime / 10_000n) - FILETIME_EPOCH_MS : undefined
    const name = appLabel(recorded)
    const key = name.toLowerCase()
    const held = merged.get(key)
    merged.set(key, held
      ? { name: held.name, runs: held.runs + runs, focusMs: held.focusMs + focusMs, ...(Math.max(held.lastRun ?? 0, lastRun ?? 0) ? { lastRun: Math.max(held.lastRun ?? 0, lastRun ?? 0) } : {}) }
      : { name, runs, focusMs, ...(lastRun ? { lastRun } : {}) })
  }
  return [...merged.values()].sort((a, b) => b.focusMs - a.focusMs || b.runs - a.runs)
}
