import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseReviewRules, parseRule, type ApprovalRule, type ReviewRule } from 'core'

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
    retire: (routineId) => serialized(async () => write((await read()).filter((r) => r.routineId !== routineId))),
  }
}
