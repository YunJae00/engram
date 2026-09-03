import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

// What the comets did, kept where a person can read it back: every step on
// a page, every picture sent to a brain, every question answered at a
// control that would commit, every wall met. One line per event, one file
// per day, inside the vault so it travels with the notes and never leaves
// the machine on its own.

export type AuditKind = 'step' | 'look' | 'approval' | 'wall'

export interface AuditEntry {
  at: string
  kind: AuditKind
  channel: string
  bot?: string
  tool?: string
  url?: string
  detail?: string
}

const DIR = 'audit'
const DETAIL_CAP = 200

export function auditDir(paths: VaultPaths): string {
  return join(paths.cache, DIR)
}

function dayOf(at: string): string {
  return at.slice(0, 10)
}

export async function appendAudit(paths: VaultPaths, entry: Omit<AuditEntry, 'at'> & { at?: string }): Promise<void> {
  const at = entry.at ?? new Date().toISOString()
  const line: AuditEntry = {
    ...entry,
    at,
    ...(entry.detail ? { detail: entry.detail.slice(0, DETAIL_CAP) } : {}),
  }
  const dir = auditDir(paths)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, `${dayOf(at)}.jsonl`), JSON.stringify(line) + '\n', 'utf8')
}

// A day's entries, oldest first; a day with no file is an empty day.
export async function readAudit(paths: VaultPaths, day: string): Promise<AuditEntry[]> {
  try {
    const text = await readFile(join(auditDir(paths), `${day}.jsonl`), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry)
  } catch {
    return []
  }
}

// The days that have entries, newest first.
export async function auditDays(paths: VaultPaths): Promise<string[]> {
  try {
    return (await readdir(auditDir(paths)))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort()
      .reverse()
  } catch {
    return []
  }
}
