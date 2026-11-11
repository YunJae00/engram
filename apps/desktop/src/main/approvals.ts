import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addReviewRule, hostOf, parseReviewRules, parseRule, type ApprovalRule, type ReviewRule } from 'core'

// The approvals the person asked to stand, kept beside the app's own state:
// a rule is about this machine's browser and this person's hand on it, not
// about the vault, so it does not travel with the notes.

const FILE = 'approvals.json'

export interface ApprovalsStore {
  list(): Promise<ApprovalRule[]>
  add(rule: ApprovalRule): Promise<void>
  forget(fingerprint: string): Promise<void>
  retire(routineId: string): Promise<void>
  reviewRules(): Promise<ReviewRule[]>
  addReviewRule(rule: ReviewRule): Promise<ReviewRule[]>
  removeReviewRule(rule: ReviewRule): Promise<ReviewRule[]>
}

// The renderer names only a kind and a bare host; main decides the operation.
export function reviewRuleInput(value: unknown): ReviewRule {
  if (typeof value !== 'object' || value === null) throw new Error('review rule must be an object')
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new Error('review rule must be a plain object')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('target')) throw new Error('review rule takes exactly kind and target')
  const { kind, target } = value as Record<string, unknown>
  if (kind !== 'ask-first' && kind !== 'allow') throw new Error('review rule kind must be ask-first or allow')
  if (typeof target !== 'string' || target.length < 1 || target.length > 253) throw new Error('site must be 1-253 characters')
  if (target !== hostOf(`https://${target}`)) throw new Error(`not a site name: ${target}`)
  return { kind, operation: 'submit', target }
}

export function approvalsStore(dir: string): ApprovalsStore {
  const path = join(dir, FILE)
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const raw = async (): Promise<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  const read = async (): Promise<ApprovalRule[]> => {
    const { rules } = await raw()
    return Array.isArray(rules) ? rules.map(parseRule).filter((r): r is ApprovalRule => r !== null) : []
  }
  const reviewRules = async (): Promise<ReviewRule[]> => {
    const file = await raw()
    if (!Object.hasOwn(file, 'reviewRules')) return []
    try {
      return parseReviewRules(JSON.stringify(file['reviewRules']))
    } catch {
      return []
    }
  }
  // Review-rule writes fail closed: a file that cannot be read is never overwritten.
  const strict = async (): Promise<{ file: Record<string, unknown>; current: ReviewRule[] }> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: {}, current: [] }
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('approvals.json is not an object')
    const file = value as Record<string, unknown>
    const current = Object.hasOwn(file, 'reviewRules') ? parseReviewRules(JSON.stringify(file['reviewRules'])) : []
    return { file, current }
  }
  const writeReview = async (file: Record<string, unknown>, next: ReviewRule[]): Promise<ReviewRule[]> => {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify({ ...file, reviewRules: next }, null, 2))
    return next
  }
  const write = async (rules: ApprovalRule[]): Promise<void> => {
    const file = await raw()
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(Object.hasOwn(file, 'reviewRules') ? { rules, reviewRules: file['reviewRules'] } : { rules }, null, 2))
  }
  return {
    list: () => serialized(read),
    add: (rule) =>
      serialized(async () => {
        const rules = await read()
        const at = rules.findIndex((r) => r.fingerprint === rule.fingerprint)
        if (at >= 0) rules[at] = rule
        else rules.push(rule)
        await write(rules)
      }),
    forget: (fingerprint) => serialized(async () => write((await read()).filter((r) => r.fingerprint !== fingerprint))),
    reviewRules: () => serialized(reviewRules),
    addReviewRule: (rule) =>
      serialized(async () => {
        const { file, current } = await strict()
        const next = addReviewRule(current, rule)
        return next.length === current.length ? current : writeReview(file, next)
      }),
    removeReviewRule: (rule) =>
      serialized(async () => {
        const { file, current } = await strict()
        const next = current.filter((r) => !(r.kind === rule.kind && r.operation === rule.operation && r.target === rule.target))
        return next.length === current.length ? current : writeReview(file, next)
      }),
    retire: (routineId) => serialized(async () => write((await read()).filter((r) => r.routineId !== routineId))),
  }
}
