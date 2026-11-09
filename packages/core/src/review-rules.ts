// Standing review rules the person sets: "ask first" or "allow automatically"
// for one operation on one concrete target. Matching is exact; ask-first wins.

export type ReviewRuleKind = 'ask-first' | 'allow'
export type ReviewDecision = 'ask' | 'allow'

export interface ReviewAction {
  operation: string
  target: string
}

export interface ReviewRule extends ReviewAction {
  kind: ReviewRuleKind
}

export const MAX_RULES_PER_KIND = 20
export const ROUTINE_CARD_TTL_MS = 30 * 60_000

const KINDS: readonly ReviewRuleKind[] = ['ask-first', 'allow']
const ASK_BY_DEFAULT = new Set(['send', 'submit'])
const OPERATION = /^[a-z][a-z0-9_-]*$/
const RULE_FIELDS = ['kind', 'operation', 'target'].sort().join(',')
const ACTION_FIELDS = ['operation', 'target'].sort().join(',')

function validTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function exactFields(value: object, fields: string): boolean {
  return Object.keys(value).sort().join(',') === fields
}

function validAction(value: unknown): value is ReviewAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !exactFields(value, ACTION_FIELDS)) return false
  const a = value as Record<string, unknown>
  return typeof a['operation'] === 'string' && OPERATION.test(a['operation']) && validTarget(a['target'])
}

function ruleError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'rule is not an object'
  if (!exactFields(value, RULE_FIELDS)) return 'rule has missing or unknown fields'
  const r = value as Record<string, unknown>
  if (!KINDS.includes(r['kind'] as ReviewRuleKind)) return `unknown rule kind: ${String(r['kind'])}`
  if (typeof r['operation'] !== 'string' || !OPERATION.test(r['operation'])) return 'operation must be a lowercase token'
  if (!validTarget(r['target'])) return 'target must be a nonempty trimmed string'
  return null
}

function rulesError(rules: unknown[] | null): string | null {
  if (rules === null) return `rules must be an array of at most ${2 * MAX_RULES_PER_KIND} rules`
  for (const rule of rules) {
    const error = ruleError(rule)
    if (error) return error
  }
  for (const kind of KINDS) {
    if (rules.filter((r) => (r as ReviewRule).kind === kind).length > MAX_RULES_PER_KIND) return `more than ${MAX_RULES_PER_KIND} ${kind} rules`
  }
  return null
}

// Copy once so getters run a single time and validation sees exactly what is used.
function plainCopy(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : value
}

// Indexed copy: the caller's iterator, methods and spread are never used.
function snapshot(rules: unknown): unknown[] | null {
  if (!Array.isArray(rules)) return null
  const length: unknown = rules.length
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 2 * MAX_RULES_PER_KIND) return null
  const copy: unknown[] = []
  for (let i = 0; i < length; i += 1) copy.push(plainCopy(rules[i]))
  return copy
}

function checkRules(rules: unknown): ReviewRule[] {
  const copy = snapshot(rules)
  const error = rulesError(copy)
  if (error) throw new Error(error)
  return copy as ReviewRule[]
}

function sameRule(a: ReviewRule, b: ReviewRule): boolean {
  return a.kind === b.kind && a.operation === b.operation && a.target === b.target
}

export function addReviewRule(rules: readonly ReviewRule[], rule: ReviewRule): ReviewRule[] {
  const next = checkRules(rules)
  const added = checkRules([rule])[0] as ReviewRule
  if (next.some((r) => sameRule(r, added))) return next
  if (next.filter((r) => r.kind === added.kind).length >= MAX_RULES_PER_KIND) {
    throw new Error(`at most ${MAX_RULES_PER_KIND} ${added.kind} rules`)
  }
  return [...next, added]
}

// Malformed or over-limit rules fail closed: nothing is allowed automatically.
export function evaluate(rules: readonly ReviewRule[], action: ReviewAction): ReviewDecision {
  try {
    const list = snapshot(rules)
    const act = plainCopy(action)
    if (rulesError(list) || !validAction(act)) return 'ask'
    const matches = (list as ReviewRule[]).filter((r) => r.operation === act.operation && r.target === act.target)
    if (matches.some((r) => r.kind === 'ask-first')) return 'ask'
    if (matches.some((r) => r.kind === 'allow')) return 'allow'
    return ASK_BY_DEFAULT.has(act.operation) ? 'ask' : 'allow'
  } catch {
    return 'ask'
  }
}

export function parseReviewRules(json: string): ReviewRule[] {
  return checkRules(JSON.parse(json) as unknown)
}

export function serializeReviewRules(rules: readonly ReviewRule[]): string {
  return JSON.stringify(checkRules(rules))
}

// Only the exact Date.prototype.toISOString() form is valid; toISOString throws on an invalid Date.
function createdMs(createdAt: unknown): number | null {
  if (typeof createdAt !== 'string') return null
  try {
    const date = new Date(createdAt)
    return date.toISOString() === createdAt ? date.getTime() : null
  } catch {
    return null
  }
}

// An invalid timestamp, an invalid clock or a card from the future counts as expired.
export function routineCardExpired(createdAt: string, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return true
  const created = createdMs(createdAt)
  if (created === null || created > nowMs) return true
  return nowMs - created >= ROUTINE_CARD_TTL_MS
}
