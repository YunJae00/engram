import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRule, type ApprovalRule } from 'core'

// The approvals the person asked to stand, kept beside the app's own state:
// a rule is about this machine's browser and this person's hand on it, not
// about the vault, so it does not travel with the notes.

const FILE = 'approvals.json'

export interface ApprovalsStore {
  list(): Promise<ApprovalRule[]>
  add(rule: ApprovalRule): Promise<void>
  forget(fingerprint: string): Promise<void>
  retire(routineId: string): Promise<void>
}

export function approvalsStore(dir: string): ApprovalsStore {
  const path = join(dir, FILE)
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const read = async (): Promise<ApprovalRule[]> => {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { rules?: unknown[] }
      return Array.isArray(raw.rules) ? raw.rules.map(parseRule).filter((r): r is ApprovalRule => r !== null) : []
    } catch {
      return []
    }
  }
  const write = async (rules: ApprovalRule[]): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify({ rules }, null, 2))
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
    retire: (routineId) => serialized(async () => write((await read()).filter((r) => r.routineId !== routineId))),
  }
}
