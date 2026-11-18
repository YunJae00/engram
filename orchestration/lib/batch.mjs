import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { runCommands } from './evidence.mjs'
import { overlaps } from './overlap.mjs'
import { dropWorktree, freshDetached, git, isCloud, loadJobs, saveJobs } from './runtime.mjs'

const MAX_BATCH = 4
const DEFAULT_BATCH = 3
const BATCH_PREFIX = 'batch-'

export function batchSize(args, env = process.env) {
  const i = args.indexOf('--batch')
  const raw = i >= 0 ? (/^\d+$/.test(args[i + 1] ?? '') ? args[i + 1] : DEFAULT_BATCH) : env.ORCH_BATCH
  const n = Number(raw ?? 0)
  return Number.isInteger(n) && n >= 2 ? Math.min(n, MAX_BATCH) : 0
}

const batchable = (q) =>
  !q.hard && q.item.bounces === 0 && q.item.attempts.length === 0 && q.plan.length === 1 && !isCloud(q.plan[0].implementer)

export function pickBatches(queue, size) {
  if (size < 2) return { groups: [], singles: queue }
  const open = []
  const singles = []
  for (const q of queue) {
    if (!batchable(q)) {
      singles.push(q)
      continue
    }
    const group = open.find((g) => g.length < size && g[0].item.area === q.item.area
      && g[0].plan[0].implementer === q.plan[0].implementer && g[0].plan[0].verifier === q.plan[0].verifier
      && g.every((o) => !overlaps(o.item.allowedFiles, q.item.allowedFiles)))
    if (group) group.push(q)
    else open.push([q])
  }
  return { groups: open.filter((g) => g.length > 1), singles: [...singles, ...open.filter((g) => g.length === 1).flat()] }
}

export const batchLabel = (ids) => `${BATCH_PREFIX}${ids[0]}-x${ids.length}`
export const batchMinutes = (minutes, n) => Math.round((minutes * (n + 1)) / 2)
export const batchOf = (attempt) => {
  const name = attempt?.logPath ? basename(attempt.logPath, '.log') : ''
  return name.startsWith(BATCH_PREFIX) ? name : null
}

export function batchSiblings(ledger, attempt) {
  const label = batchOf(attempt)
  if (!label) return []
  return ledger.items.flatMap((i) => i.attempts).filter((a) => batchOf(a) === label && !a.outcome && a.headSha)
}

export function closeMember(job, branch) {
  if (!job?.open) return true
  job.open = job.open.filter((b) => b !== branch)
  return job.open.length === 0
}

export function releaseMember(ctx, attempt) {
  const label = batchOf(attempt)
  if (!label) return true
  const jobs = loadJobs(ctx)
  const last = closeMember(jobs[label], attempt.branch)
  saveJobs(ctx, jobs)
  return last
}

export function batchPrompt({ persona, minutes, sections }) {
  return [
    persona.trim(),
    '',
    '## Batch',
    `You implement ${sections.length} independent items in this one session, one after another. You have ${minutes} minutes in total.`,
    'Each item has its own git worktree on its own branch. For an item, run every edit, check, commit and push inside that item\'s worktree only (`cd <worktree>` first); never edit another item\'s worktree.',
    'Commit each item\'s code in its worktree as you finish it. When an item cannot be done, still write its report with status `partial` or `blocked`.',
    'Write, commit and push the reports last: after every item\'s code is committed, push each item\'s report commit and branch, so the runner verifies the items together.',
    '',
    ...sections.flatMap(({ id, worktree, prompt }, i) => [`# Item ${i + 1} of ${sections.length}: ${id}`, `Worktree: \`${worktree}\``, '', prompt.trim(), '']),
  ].join('\n')
}

const CHECK = 'npm run check:quick'

export async function sharedCheck(ctx, ledger, attempt) {
  const siblings = batchSiblings(ledger, attempt)
  if (siblings.length < 2) return null
  const label = batchOf(attempt)
  const key = `${label}-check`
  const jobs = loadJobs(ctx)
  let cached = jobs[key]
  if (!cached?.shas?.includes(attempt.headSha)) {
    cached = await runSharedCheck(ctx, key, siblings.map((a) => a.headSha))
    jobs[key] = cached
    saveJobs(ctx, jobs)
  }
  return cached.exit === 0 ? cached : null
}

async function runSharedCheck(ctx, key, shas) {
  const worktree = join(ctx.worktrees, key)
  await freshDetached(ctx, worktree, ctx.base)
  try {
    await git(worktree, 'merge', '--no-edit', '-m', `batch check ${key}`, ...shas)
  } catch (error) {
    await dropWorktree(ctx, worktree)
    return { shas, exit: 1, reason: String(error.message).slice(0, 200) }
  }
  const [result] = await runCommands(worktree, key, [{ id: 'check:quick', cmd: CHECK, env: { ENGRAM_CHECK_BASE: ctx.base } }], 30 * 60_000)
  mkdirSync(ctx.logs, { recursive: true })
  const logPath = join(ctx.logs, basename(result.logPath))
  copyFileSync(join(worktree, result.logPath), logPath)
  await dropWorktree(ctx, worktree)
  return { shas, exit: result.exit, logPath, tail: result.tail }
}

export function sharedResult(shared, worktree, name) {
  const logPath = `orchestration/logs/${name}-check_quick.log`
  mkdirSync(join(worktree, 'orchestration/logs'), { recursive: true })
  copyFileSync(shared.logPath, join(worktree, logPath))
  return { id: 'check:quick', cmd: CHECK, exit: 0, logPath, tail: `shared batch check over ${shared.shas.length} items\n${shared.tail ?? ''}`, screenshots: [] }
}
