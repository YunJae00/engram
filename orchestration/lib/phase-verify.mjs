import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkVerdict } from './aggregate.mjs'
import { deleteRemoteBranch, fetchBranch, tipSha } from './git.mjs'
import { followup, rung, transition } from './ledger.mjs'
import { roundOutcome, verifyDecision } from './loop.mjs'
import { verifierPrompt } from './prompt.mjs'
import {
  attemptRef, dropWorktree, freshDetached, git, isCloud, jobFinished, kill, launchAgent, loadBrief, loadJobs, note, persona,
  readJsonOrNull, releaseSlot, save, saveJobs, schema,
} from './runtime.mjs'
import { finish, rejectDesign } from './phase-implement.mjs'

const label = (item, attempt, kind) => `${item.id}-${attempt.n}-${kind}`
const verdictRel = (item, attempt, kind) => `orchestration/verdicts/${item.id}-${attempt.n}-${kind}.json`

function parseVerdict(job, worktreeFile) {
  const fromFile = readJsonOrNull(worktreeFile)
  if (fromFile) return fromFile
  const text = job.outPath && existsSync(job.outPath) ? readFileSync(job.outPath, 'utf8') : ''
  try {
    const value = JSON.parse(text)
    if (job.agent !== 'claude-local') return value
    return value.structured_output ?? JSON.parse(value.result)
  } catch {
    return null
  }
}

function collect(ctx, ledger, item, attempt, kind, job) {
  kill(job.pid)
  releaseSlot(ctx, job.pid)
  const raw = parseVerdict(job, join(job.worktree, verdictRel(item, attempt, kind)))
  const checked = raw ? checkVerdict(raw, schema(ctx, 'verdict')) : { valid: false, reason: 'no verdict produced' }
  const mismatch = raw && (raw.id !== item.id || raw.attempt !== attempt.n || raw.kind !== kind || raw.headSha !== job.headSha)
  const reason = !checked.valid ? checked.reason : mismatch ? 'verdict id/attempt/kind/headSha does not match the job' : null
  const verdict = reason
    ? { id: item.id, attempt: attempt.n, kind, verdict: 'cannot_verify', headSha: job.headSha, evidence: [], findings: [] }
    : raw
  const rel = verdictRel(item, attempt, kind).replace(/\.json$/, job.tries > 1 ? `-r${job.tries}.json` : '.json')
  mkdirSync(join(ctx.root, 'orchestration/verdicts'), { recursive: true })
  writeFileSync(join(ctx.root, rel), `${JSON.stringify(verdict, null, 2)}\n`)
  item.verdicts.push({ attempt: attempt.n, kind, verdict: verdict.verdict, headSha: verdict.headSha, path: rel })
  job.done = true
  job.path = rel
  note(ctx, item.id, 'verify', `${kind} ${verdict.verdict}`, reason ?? `attempt ${attempt.n}`, rel)
  save(ctx, ledger)
}

async function launchVerifier(ctx, item, attempt, kind, tries) {
  const name = label(item, attempt, kind)
  const worktree = join(ctx.worktrees, name)
  await freshDetached(ctx, worktree, attempt.headSha)
  const verdictPath = verdictRel(item, attempt, kind)
  const prompt = verifierPrompt({
    persona: persona(ctx, `verifier-${kind}`), kind, brief: loadBrief(ctx, item.id), headSha: attempt.headSha, verdictPath,
    schemaText: readFileSync(join(ctx.orch, 'schemas/verdict.schema.json'), 'utf8'), attempt: attempt.n, baseBranch: ctx.base,
  })
  const launched = await launchAgent(ctx, {
    agent: attempt.verifier, label: name, cwd: worktree, prompt, role: 'verify', minutes: ctx.roles.minutes.verify,
    schemaPath: join(ctx.orch, 'schemas/verdict.schema.json'),
  })
  if (!launched) {
    await dropWorktree(ctx, worktree)
    return null
  }
  note(ctx, item.id, 'verify', `launch ${attempt.verifier} ${kind}`, `attempt ${attempt.n} try ${tries}`, launched.logPath)
  return { ...launched, worktree, tries, headSha: attempt.headSha }
}

async function resetJobs(ctx, item, attempt, jobs) {
  for (const kind of ctx.roles.verifierKinds) {
    const job = jobs[label(item, attempt, kind)]
    if (!job) continue
    kill(job.pid)
    releaseSlot(ctx, job.pid)
    await dropWorktree(ctx, job.worktree)
    delete jobs[label(item, attempt, kind)]
  }
}

export async function verifyAttempt(ctx, ledger, item, attempt) {
  const ref = attemptRef(ctx, attempt)
  if (isCloud(attempt.implementer)) await fetchBranch(ctx.opts, attempt.branch)
  const tip = await tipSha(ctx.opts, ref)
  const jobs = loadJobs(ctx)
  if (tip !== attempt.headSha) {
    await resetJobs(ctx, item, attempt, jobs)
    saveJobs(ctx, jobs)
    note(ctx, item.id, 'verify', 're-check', `branch moved from ${attempt.headSha} to ${tip}; machine checks run again`, ref)
    delete attempt.headSha
    return save(ctx, ledger)
  }
  const byKind = {}
  const tries = {}
  let pending = false
  for (const kind of ctx.roles.verifierKinds) {
    const name = label(item, attempt, kind)
    let job = jobs[name]
    if (!job || job.retry) {
      const launched = await launchVerifier(ctx, item, attempt, kind, (job?.tries ?? 0) + 1)
      if (launched) {
        jobs[name] = launched
        saveJobs(ctx, jobs)
      }
      pending = true
      continue
    }
    if (!job.done) {
      const produced = readJsonOrNull(join(job.worktree, verdictRel(item, attempt, kind))) !== null
      if (!produced && !jobFinished(job)) {
        pending = true
        continue
      }
      collect(ctx, ledger, item, attempt, kind, job)
      await dropWorktree(ctx, job.worktree)
    }
    tries[kind] = job.tries
    byKind[kind] = readJsonOrNull(join(ctx.root, job.path))
  }
  saveJobs(ctx, jobs)
  if (pending) return
  const decision = verifyDecision(byKind, tip, tries)
  if (decision.action === 'retry') {
    for (const kind of decision.kinds) jobs[label(item, attempt, kind)].retry = true
    saveJobs(ctx, jobs)
    return note(ctx, item.id, 'verify', `retry ${decision.kinds.join(',')}`, 'cannot_verify on first try')
  }
  if (decision.action === 'reverify') {
    await resetJobs(ctx, item, attempt, jobs)
    saveJobs(ctx, jobs)
    return note(ctx, item.id, 'verify', 're-verify', 'verdicts are stale for the tip', tip)
  }
  for (const f of decision.followups) followup(ctx.root, f)
  const evidence = Object.values(jobs).filter((j) => j.headSha === tip && j.path).map((j) => j.path).join(' ')
  if (decision.action === 'needs_human') {
    await finish(ctx, attempt, 'invalid')
    item.reason = 'cannot_verify after one retry'
    note(ctx, item.id, 'verify', 'needs_human', item.reason, evidence)
    await supersede(ctx, item, item.attempts.filter((a) => !a.outcome))
    transition(item, 'needs_human')
    return save(ctx, ledger)
  }
  await finish(ctx, attempt, decision.action)
  note(ctx, item.id, 'verify', `attempt ${attempt.n} ${decision.action}`, `aggregate of ${Object.keys(byKind).join(',')}`, evidence)
  save(ctx, ledger)
}

export async function dropBranch(ctx, attempt) {
  await deleteRemoteBranch(ctx.opts, attempt.branch).catch(() => null)
  await git(ctx.root, 'branch', '-D', attempt.branch).catch(() => null)
}

export async function cleanAttempt(ctx, item, attempt) {
  const jobs = loadJobs(ctx)
  await resetJobs(ctx, item, attempt, jobs)
  saveJobs(ctx, jobs)
  await dropWorktree(ctx, attempt.worktree)
}

async function supersede(ctx, item, losers) {
  for (const loser of losers) {
    await finish(ctx, loser, 'superseded')
    await cleanAttempt(ctx, item, loser)
    await dropBranch(ctx, loser)
    note(ctx, item.id, 'verify', `attempt ${loser.n} superseded`, 'another attempt verified first', loser.branch)
  }
}

export async function bounce(ctx, ledger, item, why) {
  for (const attempt of item.attempts) await cleanAttempt(ctx, item, attempt)
  for (const attempt of item.attempts.filter((a) => a.outcome !== 'pass')) await dropBranch(ctx, attempt)
  item.bounces += 1
  transition(item, 'bounced')
  note(ctx, item.id, 'bounce', `bounce ${item.bounces}`, why)
  const next = rung(item, ctx.roles)
  if (next) {
    const redesign = rejectDesign(ctx, item)
    transition(item, 'briefed')
    note(ctx, item.id, 'bounce', 'briefed', `next rung ${next.implementer} / ${next.verifier}${redesign ? '; design rejected, designing again' : ''}`)
  } else {
    item.reason = `ladder exhausted after ${item.bounces} bounces: ${why}`
    transition(item, 'needs_human')
    note(ctx, item.id, 'bounce', 'needs_human', item.reason)
  }
  save(ctx, ledger)
}

export async function settle(ctx, ledger, item) {
  if (!['implementing', 'implemented', 'verifying'].includes(item.state)) return
  const outcome = roundOutcome(item.attempts.filter((a) => a.outcome !== 'superseded'))
  if (outcome.action === 'wait') return
  if (outcome.action === 'bounce') {
    const last = item.attempts.at(-1)
    return bounce(ctx, ledger, item, `no attempt passed (last: attempt ${last.n} ${last.outcome})`)
  }
  await supersede(ctx, item, outcome.losers)
  transition(item, 'verified')
  note(ctx, item.id, 'verify', 'verified', `attempt ${outcome.winner.n} by ${outcome.winner.implementer} wins`, outcome.winner.headSha)
  save(ctx, ledger)
}
