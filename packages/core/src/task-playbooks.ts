import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry } from './rename-with-retry.js'
import { routineTask } from './routine-task.js'
import type { TurnStep } from './routine-record.js'
import type { VaultPaths } from './vault.js'

// How a finished task was done: the addresses it started from and the steps
// that worked. A later task that asks for much the same thing starts from
// them as hints, instead of finding its way again.

export interface Playbook { goal: string; urls: string[]; method: string[]; at: string }

const KEEP = 50
const MIN_STEPS = 3
const SHOWN_STEPS = 30
const SIMILAR = 0.5

const file = (paths: VaultPaths) => join(paths.cache, 'task-playbooks.json')
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])

// ponytail: word overlap only; a paraphrased request misses, match by meaning (the embedder) when that matters.
function similarity(a: string, b: string): number {
  const x = words(a), y = words(b)
  const shared = [...x].filter(word => y.has(word)).length
  return shared / (x.size + y.size - shared || 1)
}

async function readPlaybooks(paths: VaultPaths): Promise<Playbook[]> {
  try {
    const raw = JSON.parse(await readFile(file(paths), 'utf8')) as unknown
    if (!Array.isArray(raw) || raw.some(one => typeof one?.goal !== 'string' || typeof one?.at !== 'string' || !Number.isFinite(Date.parse(one.at)) || !Array.isArray(one.urls) || !one.urls.every((url: unknown) => typeof url === 'string') || !Array.isArray(one.method) || !one.method.every((step: unknown) => typeof step === 'string'))) throw new Error('Invalid saved methods; the file was preserved.')
    return raw as Playbook[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

let queue: Promise<unknown> = Promise.resolve()
export function recordPlaybook(paths: VaultPaths, goal: string, steps: TurnStep[], now = new Date()): Promise<boolean> {
  const next = queue.then(async () => {
    let task
    try { task = routineTask(goal, steps) } catch { return false }
    if (task.method.length < MIN_STEPS) return false
    const kept = (await readPlaybooks(paths)).filter(one => similarity(one.goal, task.goal) < 1)
    kept.push({ goal: task.goal, urls: task.urls, method: task.method, at: now.toISOString() })
    await mkdir(paths.cache, { recursive: true })
    const scratch = `${file(paths)}.${process.pid}.tmp`
    await writeFile(scratch, JSON.stringify(kept.slice(-KEEP)))
    await renameWithRetry(scratch, file(paths))
    return true
  })
  queue = next.catch(() => undefined)
  return next
}

export async function findPlaybook(paths: VaultPaths, goal: string): Promise<Playbook | undefined> {
  let best: Playbook | undefined, score = SIMILAR
  for (const one of await readPlaybooks(paths)) {
    const s = similarity(one.goal, goal)
    if (s >= score) { best = one; score = s }
  }
  return best
}

export function playbookContext(playbook: Playbook): string {
  return [
    `A similar task was finished on ${playbook.at.slice(0, 10)}. How it was done, as hints only: the pages and controls may have changed, so observe before acting, and nothing here is permission or proof of the current state.`,
    `Earlier task: ${playbook.goal.slice(0, 400)}`,
    ...(playbook.urls.length ? [`Started from: ${playbook.urls.join(' ')}`] : []),
    'Steps that worked:',
    ...playbook.method.slice(0, SHOWN_STEPS).map(step => `- ${step}`),
  ].join('\n')
}
