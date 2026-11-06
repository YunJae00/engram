import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { changedFiles, fetchBranch, fileAtRef, lsRemote, tipSha } from './git.mjs'
import { readTokens } from './launch-local.mjs'
import { isHard, transition } from './ledger.mjs'
import {
  deadlineAt, designLocations, designPath, findDesign, isStalled, lineage, machineCheck, needsRedesign, pickDesign, plannedAttempts,
  rejectedDesignPath,
} from './loop.mjs'
import { runnable } from './overlap.mjs'
import { alive } from './procs.mjs'
import { designerPrompt, implementerPrompt } from './prompt.mjs'
import {
  attemptRef, briefPath, dropWorktree, freshDetached, git, isCloud, jobFinished, kill, launchAgent, linkNodeModules, loadBrief, loadJobs,
  note, persona, previousFindings, readJsonOrNull, releaseSlot, reportPath, RULES, save, saveJobs, schema, slotFree,
} from './runtime.mjs'
import { validate } from './validate.mjs'

const DESIGNERS = { claude: 'claude-local', codex: 'codex-local' }

export function promote(ctx, ledger) {
  for (const item of ledger.items.filter((i) => i.state === 'queued')) {
    const brief = readJsonOrNull(briefPath(ctx, item.id))
    const errors = brief ? validate(schema(ctx, 'brief'), brief) : ['brief file missing or not JSON']
    if (brief && brief.id !== item.id) errors.push(`brief id ${brief.id} is not ${item.id}`)
    if (errors.length) {
      item.reason = errors.join('; ')
      transition(item, 'blocked')
      note(ctx, item.id, 'brief', 'blocked', item.reason)
    } else {
      transition(item, 'briefed')
      note(ctx, item.id, 'brief', 'briefed', 'brief validates')
    }
    save(ctx, ledger)
  }
}

export async function startBriefed(ctx, ledger) {
  for (const id of runnable(ledger.items)) {
    const item = ledger.items.find((i) => i.id === id)
    const brief = loadBrief(ctx, id)
    const hard = isHard({ ...item, repeat: brief.repeat }, ctx.roles)
    if (hard && !brief.design) await startDesign(ctx, ledger, item)
    else await startImplement(ctx, ledger, item, brief, hard)
  }
}

async function startDesign(ctx, ledger, item) {
  if (ctx.dryRun) return ctx.log(`dry-run ${item.id}: would launch designers claude-local and codex-local`)
  transition(item, 'designing')
  note(ctx, item.id, 'design', 'designing', 'hard item without a chosen design')
  save(ctx, ledger)
  await designTick(ctx, ledger, item)
}

async function launchDesigner(ctx, item, line, agent, tries) {
  const label = `${item.id}-design-${line}`
  const worktree = join(ctx.worktrees, label)
  const { target } = designLocations(ctx.root, worktree, item.id, line)
  mkdirSync(dirname(target), { recursive: true })
  await fetchBranch(ctx.opts, ctx.roles.baseBranch)
  await freshDetached(ctx, worktree, ctx.base)
  const rejected = join(ctx.root, rejectedDesignPath(item.id))
  const prompt = designerPrompt({
    persona: persona(ctx, 'designer'), rules: RULES, brief: loadBrief(ctx, item.id), designPath: target,
    findings: previousFindings(ctx, item), rejectedDesign: existsSync(rejected) ? readFileSync(rejected, 'utf8') : null,
  })
  const launched = await launchAgent(ctx, {
    agent, label, cwd: worktree, prompt, role: 'design', minutes: ctx.roles.minutes.design, addDirs: [dirname(target)],
  })
  if (!launched) {
    await dropWorktree(ctx, worktree)
    return null
  }
  note(ctx, item.id, 'design', `launch ${agent}`, `designer try ${tries}`, launched.logPath)
  return { ...launched, worktree, tries }
}

async function collectDesign(ctx, item, line, agent, job) {
  kill(job.pid)
  releaseSlot(ctx, job.pid)
  const { target, candidates } = designLocations(ctx.root, job.worktree, item.id, line)
  const found = findDesign(candidates, existsSync)
  if (found && found !== target) copyFileSync(found, target)
  await dropWorktree(ctx, job.worktree)
  job.done = true
  note(ctx, item.id, 'design', `${agent} finished`, found ? `design at ${found}` : 'no design file', target)
}

export async function designTick(ctx, ledger, item) {
  const jobs = loadJobs(ctx)
  const now = new Date()
  for (const [line, agent] of Object.entries(DESIGNERS)) {
    const label = `${item.id}-design-${line}`
    const job = jobs[label]
    if (!job || job.retry) {
      if (!slotFree(ctx, agent)) continue
      const launched = await launchDesigner(ctx, item, line, agent, (job?.tries ?? 0) + 1)
      if (launched) jobs[label] = launched
      saveJobs(ctx, jobs)
    } else if (!job.done && jobFinished(job, now)) {
      await collectDesign(ctx, item, line, agent, job)
      saveJobs(ctx, jobs)
    }
  }
  const mine = Object.keys(DESIGNERS).map((line) => [line, jobs[`${item.id}-design-${line}`]])
  if (!mine.every(([, job]) => job?.done && !job.retry)) return
  const designs = Object.keys(DESIGNERS)
    .map((line) => ({ lineage: line, path: join(ctx.root, designPath(item.id, line)) }))
    .filter((d) => existsSync(d.path))
    .map((d) => ({ ...d, mtimeMs: statSync(d.path).mtimeMs }))
  if (designs.length === 0) {
    const retry = mine.filter(([, job]) => (job.tries ?? 1) < 2)
    if (retry.length) {
      for (const [, job] of retry) job.retry = true
      saveJobs(ctx, jobs)
      return note(ctx, item.id, 'design', `relaunch ${retry.map(([line]) => line).join(',')}`, 'no design file at either location')
    }
    item.reason = 'no designer produced a design after one relaunch'
    transition(item, 'needs_human')
    note(ctx, item.id, 'design', 'needs_human', item.reason)
    return save(ctx, ledger)
  }
  const pick = pickDesign(designs, mine.every(([, job]) => now.getTime() > Date.parse(job.deadlineAt)))
  if (pick) await setDesign(ctx, ledger, item, pick, 'deadline passed; earliest design wins')
}

export async function setDesign(ctx, ledger, item, line, why) {
  const path = designPath(item.id, line)
  if (!existsSync(join(ctx.root, path))) throw new Error(`${path} does not exist`)
  if (item.state !== 'designing') throw new Error(`${item.id} is ${item.state}, not designing`)
  const brief = loadBrief(ctx, item.id)
  brief.design = path
  writeFileSync(briefPath(ctx, item.id), `${JSON.stringify(brief, null, 2)}\n`)
  item.criteria = brief.criteria
  const jobs = loadJobs(ctx)
  for (const other of Object.keys(DESIGNERS)) {
    const job = jobs[`${item.id}-design-${other}`]
    if (job && !job.done) kill(job.pid)
    if (job) releaseSlot(ctx, job.pid)
    await dropWorktree(ctx, join(ctx.worktrees, `${item.id}-design-${other}`))
    delete jobs[`${item.id}-design-${other}`]
  }
  saveJobs(ctx, jobs)
  transition(item, 'briefed')
  note(ctx, item.id, 'design', `pick ${line}`, why, path)
  save(ctx, ledger)
}

// Returns true when the chosen design was set aside so the item is designed again.
export function rejectDesign(ctx, item) {
  const brief = loadBrief(ctx, item.id)
  if (!needsRedesign(item.bounces, Boolean(brief.design))) return false
  const chosen = join(ctx.root, brief.design)
  if (existsSync(chosen)) renameSync(chosen, join(ctx.root, rejectedDesignPath(item.id)))
  for (const line of Object.keys(DESIGNERS)) rmSync(join(ctx.root, designPath(item.id, line)), { force: true })
  delete brief.design
  writeFileSync(briefPath(ctx, item.id), `${JSON.stringify(brief, null, 2)}\n`)
  return true
}

function withDesign(ctx, prompt, brief) {
  const path = brief.design ? join(ctx.root, brief.design) : null
  return path && existsSync(path) ? `${prompt}\n\n## Design (chosen)\n${readFileSync(path, 'utf8')}` : prompt
}

async function launchImplementer(ctx, ledger, item, brief, step) {
  const n = item.attempts.length + 1
  const branch = `${ctx.roles.branchPrefix}${item.id}-${n}`
  const label = `${item.id}-${n}`
  const cloud = isCloud(step.implementer)
  const prompt = withDesign(ctx, implementerPrompt({
    persona: persona(ctx, 'implementer'), rules: RULES, brief, branch, baseBranch: ctx.roles.baseBranch, reportPath: reportPath(item.id), cloud,
    findings: previousFindings(ctx, item),
  }), brief)
  const attempt = { n, implementer: step.implementer, verifier: step.verifier, branch, startedAt: new Date().toISOString() }
  attempt.deadlineAt = deadlineAt(attempt.startedAt, ctx.roles.minutes.implement)
  item.attempts.push(attempt)
  try {
    let worktree
    if (!cloud) {
      worktree = join(ctx.worktrees, label)
      await fetchBranch(ctx.opts, ctx.roles.baseBranch)
      await dropWorktree(ctx, worktree)
      await git(ctx.root, 'worktree', 'add', '-B', branch, worktree, ctx.base)
      linkNodeModules(ctx.root, worktree)
      attempt.worktree = worktree
    }
    const job = await launchAgent(ctx, { agent: step.implementer, label, cwd: worktree, prompt, role: 'implement', minutes: ctx.roles.minutes.implement })
    if (!job) throw new Error('no free local slot')
    Object.assign(attempt, { logPath: job.logPath, startedAt: job.startedAt, deadlineAt: job.deadlineAt })
    if (job.sessionId) attempt.sessionId = job.sessionId
    if (job.pid) attempt.pid = job.pid
    note(ctx, item.id, 'implement', `launch ${step.implementer} attempt ${n}`, `rung ${item.bounces}`, job.sessionId ?? job.logPath)
    save(ctx, ledger)
  } catch (error) {
    await finish(ctx, attempt, 'invalid')
    note(ctx, item.id, 'implement', `launch ${step.implementer} attempt ${n} failed`, String(error.message).slice(0, 300))
  }
}

async function startImplement(ctx, ledger, item, brief, hard) {
  const plan = plannedAttempts(item, ctx.roles, hard)
  if (plan.length === 0) {
    item.reason = 'ladder exhausted'
    transition(item, 'needs_human')
    note(ctx, item.id, 'implement', 'needs_human', item.reason)
    return save(ctx, ledger)
  }
  const local = plan.filter((step) => !isCloud(step.implementer)).length
  if (ctx.dryRun) {
    return ctx.log(`dry-run ${item.id}: would launch ${plan.map((s) => `${s.implementer} (verifier ${s.verifier})`).join(' and ')} on rung ${item.bounces}`)
  }
  if (local > ctx.sem.free()) return ctx.log(`${item.id}: waiting for ${local} local slot(s)`)
  for (const step of plan) await launchImplementer(ctx, ledger, item, brief, step)
  transition(item, 'implementing')
  note(ctx, item.id, 'implement', 'implementing', hard && plan.length > 1 ? 'hard item after a FAIL: claude and codex reimplement at once' : `rung ${item.bounces}`)
  save(ctx, ledger)
}

export async function finish(ctx, attempt, outcome) {
  kill(attempt.pid)
  releaseSlot(ctx, attempt.pid)
  attempt.outcome = outcome
  attempt.finishedAt ??= new Date().toISOString()
  if (attempt.logPath && !isCloud(attempt.implementer)) {
    const claude = lineage(attempt.implementer) === 'claude'
    attempt.tokens = await readTokens(claude ? 'claude' : 'codex', claude ? attempt.logPath.replace(/\.log$/, '.out.json') : attempt.logPath)
  } else attempt.tokens ??= null
}

export async function checkImplementation(ctx, ledger, item, attempt) {
  const cloud = isCloud(attempt.implementer)
  const ref = attemptRef(ctx, attempt)
  const path = reportPath(item.id)
  let text = null
  if (!cloud || (await lsRemote(ctx.opts, attempt.branch))) {
    if (cloud) await fetchBranch(ctx.opts, attempt.branch)
    text = await fileAtRef(ctx.opts, ref, path)
  }
  if (!text) {
    const exited = !cloud && !alive(attempt.pid)
    if (exited || isStalled(attempt.deadlineAt, new Date(), false)) {
      await finish(ctx, attempt, exited ? 'invalid' : 'stalled')
      note(ctx, item.id, 'implement', `attempt ${attempt.n} ${attempt.outcome}`, exited ? 'process exited without a report' : 'deadline passed without a report', attempt.logPath)
      save(ctx, ledger)
    }
    return
  }
  const report = readJsonText(text)
  const tip = await tipSha(ctx.opts, ref)
  const parent = await tipSha(ctx.opts, `${ref}^`).catch(() => null)
  const check = machineCheck({
    itemId: item.id, report, reportErrors: report ? validate(schema(ctx, 'report'), report) : [],
    changed: await changedFiles(ctx.opts, ctx.base, ref), allowedFiles: item.allowedFiles, reportPath: path, tip, parent,
  })
  attempt.reportPath = path
  attempt.finishedAt = new Date().toISOString()
  if (!check.ok) {
    await finish(ctx, attempt, 'invalid')
    note(ctx, item.id, 'implement', `attempt ${attempt.n} invalid`, check.reason, `${ref} ${tip}`)
    return save(ctx, ledger)
  }
  attempt.headSha = tip
  if (item.state === 'implementing') {
    transition(item, 'implemented')
    note(ctx, item.id, 'implement', 'implemented', `attempt ${attempt.n} passed machine checks`, tip)
    transition(item, 'verifying')
  }
  note(ctx, item.id, 'verify', 'verifying', `attempt ${attempt.n} by ${attempt.implementer}, verifier ${attempt.verifier}`, tip)
  save(ctx, ledger)
}

function readJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

