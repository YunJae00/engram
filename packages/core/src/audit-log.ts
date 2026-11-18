import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

export type AuditKind = 'step' | 'result' | 'look' | 'approval' | 'wall'

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
const RESULT_CAP = 30_000
const SECRET = /((?:password|passwd|pwd|passcode|pin|otp|secret|token|api[_ -]?key|비밀번호|인증번호)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi

export function redactSecrets(text: string): string {
  return text.replace(SECRET, '$1***')
}

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
    ...(entry.detail ? { detail: redactSecrets(entry.detail).slice(0, entry.kind === 'result' ? RESULT_CAP : DETAIL_CAP) } : {}),
  }
  const dir = auditDir(paths)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, `${dayOf(at)}.jsonl`), JSON.stringify(line) + '\n', 'utf8')
}

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
