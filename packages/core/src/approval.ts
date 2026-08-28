import { createHash } from 'node:crypto'

// An approval the person gave once and asked to stand: the same procedure,
// posting to the same site, filling the same fields. Named by a fingerprint
// of those three - never by what was typed, so a rule that let today's entry
// through lets tomorrow's through and nothing else.

export interface GatedAction {
  routineId: string
  kind: 'submit'
  host: string
  fieldLabels: string[]
}

export interface ApprovalRule {
  fingerprint: string
  routineId: string
  host: string
  createdAt: string
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

export function fingerprintOf(action: GatedAction): string {
  const labels = [...action.fieldLabels].map((l) => l.trim().toLowerCase()).sort()
  return createHash('sha256').update(JSON.stringify([action.routineId, action.kind, action.host.toLowerCase(), labels])).digest('hex')
}

export function ruleFor(action: GatedAction, now = new Date()): ApprovalRule {
  return { fingerprint: fingerprintOf(action), routineId: action.routineId, host: action.host.toLowerCase(), createdAt: now.toISOString() }
}

export function ruleCovers(rules: readonly ApprovalRule[], action: GatedAction): ApprovalRule | null {
  const want = fingerprintOf(action)
  return rules.find((r) => r.fingerprint === want && r.routineId === action.routineId && r.host === action.host.toLowerCase()) ?? null
}

// A row read back from disk, or nothing.
export function parseRule(value: unknown): ApprovalRule | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (typeof r['fingerprint'] !== 'string' || typeof r['routineId'] !== 'string' || typeof r['host'] !== 'string') return null
  return {
    fingerprint: r['fingerprint'],
    routineId: r['routineId'],
    host: r['host'],
    createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : new Date(0).toISOString(),
  }
}
