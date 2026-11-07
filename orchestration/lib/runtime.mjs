import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { blockingFindings } from './aggregate.mjs'
import { addWorktree, ensureBranch, fetchBranch, removeWorktree } from './git.mjs'
import { launchCloud } from './launch-cloud.mjs'
import { resolveCodexBin } from './codex-bin.mjs'
import { launchClaude, launchCodex, withNodeOnPath } from './launch-local.mjs'
import { decide, loadRoles, saveLedger } from './ledger.mjs'
import { deadlineAt } from './loop.mjs'
import { alive, Semaphore } from './procs.mjs'
import { validate } from './validate.mjs'

export const RULES = [
  '- Code and comments in English only. No narrative comments; a one-line why only when the code cannot show it.',
  '- Every file stays at or under 400 lines.',
  '- No stubs, TODOs, placeholders or unimplemented branches.',
  '- Commit subjects are lowercase imperative English.',
  '- No AI trailers and no Co-Authored-By lines in commits.',
  '- No new dependencies. Temporary files only under `tmp/`.',
].join('\n')

export function createContext(root, { dryRun = false, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const roles = loadRoles(root)
  const orch = join(root, 'orchestration')
  let sem = null
  return {
    root,
    roles,
    dryRun,
    log,
    opts: { root, remote: roles.workRemote },
    base: `${roles.workRemote}/${roles.baseBranch}`,
    orch,
    logs: join(orch, 'logs'),
    worktrees: join(root, 'tmp/orch/worktrees'),
    launchWorktree: join(root, 'tmp/orch/launch'),
    nextWorktree: join(root, 'tmp/orch/next'),
    get sem() {
      sem ??= new Semaphore(roles.maxLocalAgents, root)
      return sem
    },
  }
}

export function sh(cwd, cmd, args, { logPath, timeoutMs = 0, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: withNodeOnPath({ ...process.env, ...env }) })
    let out = ''
    const onData = (d) => { out += d }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const finish = (code) => {
      if (logPath) writeFileSync(logPath, `$ ${cmd} ${args.join(' ')}\n${out}\nexit ${code}\n`, { flag: 'a' })
      resolve({ code, out: out.trim() })
    }
    child.on('error', (e) => { out += String(e.message); finish(-1) })
    child.on('close', (code) => finish(code ?? -1))
  })
}

export async function git(cwd, ...args) {
  const { code, out } = await sh(cwd, 'git', args)
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${out}`)
  return out
}

export function save(ctx, ledger) {
  const errors = validate(readJson(join(ctx.orch, 'schemas/ledger.schema.json')), ledger)
  if (errors.length) throw new Error(`ledger invalid: ${errors.join('; ')}`)
  if (!ctx.dryRun) saveLedger(ctx.root, ledger)
}

export function note(ctx, item, phase, decision, why, evidence = '', result = '') {
  ctx.log(`${item} ${phase}: ${decision}${why ? ` (${why})` : ''}`)
  if (!ctx.dryRun) decide(ctx.root, { item, phase, decision, why, evidence, result })
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function readJsonOrNull(path) {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

export const briefPath = (ctx, id) => join(ctx.orch, 'briefs', `${id}.json`)
export const loadBrief = (ctx, id) => readJson(briefPath(ctx, id))
export const schema = (ctx, name) => readJson(join(ctx.orch, 'schemas', `${name}.schema.json`))
export const persona = (ctx, name) => readFileSync(join(ctx.orch, 'personas', `${name}.md`), 'utf8')
export const previousFindings = (ctx, item) =>
  blockingFindings(item.verdicts.map((ref) => readJsonOrNull(join(ctx.root, ref.path))).filter(Boolean))
export const reportPath = (id) => `orchestration/reports/${id}.json`
export const isCloud = (agent) => agent === 'claude-cloud'

/** Pick the CLI model id from roles.models for this agent + phase. */
export function resolveAgentModel(roles, { agent, role }) {
  const models = roles?.models
  if (!models) return undefined
  if (agent === 'codex-local') {
    const codex = models.codex
    if (typeof codex === 'string') return codex
    return codex?.[role] || undefined
  }
  if (agent === 'claude-cloud' || agent === 'claude-local') {
    return models.claude?.[role] || undefined
  }
  return undefined
}

export const attemptRef = (ctx, attempt) => (isCloud(attempt.implementer) ? `${ctx.opts.remote}/${attempt.branch}` : attempt.branch)

const jobsPath = (ctx) => join(ctx.logs, 'jobs.json')

export function loadJobs(ctx) {
  return readJsonOrNull(jobsPath(ctx)) ?? {}
}

export function saveJobs(ctx, jobs) {
  if (ctx.dryRun) return
  mkdirSync(ctx.logs, { recursive: true })
  const tmp = `${jobsPath(ctx)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(jobs, null, 2))
  renameSync(tmp, jobsPath(ctx))
}

export function kill(pid) {
  if (!pid || !alive(pid)) return
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM')
      return
    } catch {
      continue
    }
  }
}

export function jobFinished(job, now = new Date()) {
  if (job.sessionId) return false
  return !alive(job.pid) || now.getTime() > Date.parse(job.deadlineAt)
}

export async function dropWorktree(ctx, path) {
  if (!path || !existsSync(path)) return
  await removeWorktree(ctx.opts, path).catch(() => rmSync(path, { recursive: true, force: true }))
  await git(ctx.root, 'worktree', 'prune').catch(() => '')
}

export const NODE_MODULES = ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules']

export function linkNodeModules(root, worktree) {
  for (const rel of NODE_MODULES) {
    const target = join(root, rel)
    const link = join(worktree, rel)
    if (!existsSync(target) || existsSync(link) || isLink(link)) continue
    mkdirSync(join(link, '..'), { recursive: true })
    symlinkSync(target, link, 'dir')
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export async function freshDetached(ctx, path, ref) {
  await dropWorktree(ctx, path)
  mkdirSync(ctx.worktrees, { recursive: true })
  await addWorktree(ctx.opts, path, ref, { detach: true })
  linkNodeModules(ctx.root, path)
}

export async function prepareNext(ctx) {
  await fetchBranch(ctx.opts, ctx.roles.baseBranch)
  if (!existsSync(ctx.nextWorktree)) await addWorktree(ctx.opts, ctx.nextWorktree, ctx.base, { detach: true })
  await git(ctx.nextWorktree, 'reset', '--hard')
  await git(ctx.nextWorktree, 'checkout', '--detach', ctx.base)
  return ctx.nextWorktree
}

// Keep the integration branch current with main before item branches or integration checks use it.
export async function syncBaseBranch(ctx, phase = 'run') {
  await fetchBranch(ctx.opts, ctx.roles.mainBranch)
  const action = await ensureBranch(ctx.opts, ctx.roles.baseBranch, `${ctx.opts.remote}/${ctx.roles.mainBranch}`)
  if (action) {
    await fetchBranch(ctx.opts, ctx.roles.baseBranch)
    note(ctx, 'batch', phase, `${action} ${ctx.roles.baseBranch}`, `from ${ctx.roles.mainBranch}`)
  }
  return action
}

async function prepareLaunch(ctx) {
  const branch = ctx.roles.baseBranch
  await fetchBranch(ctx.opts, branch)
  if (!existsSync(ctx.launchWorktree)) {
    const local = await sh(ctx.root, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    const args = local.code === 0 ? [ctx.launchWorktree, branch] : ['-b', branch, ctx.launchWorktree, ctx.base]
    await git(ctx.root, 'worktree', 'add', ...args)
  }
  await git(ctx.launchWorktree, 'checkout', branch)
  await git(ctx.launchWorktree, 'pull', '--ff-only', ctx.opts.remote, branch)
}

export function slotFree(ctx, agent) {
  return isCloud(agent) || ctx.sem.free() > 0
}

// Codex needs full access to commit through a linked worktree's gitdir and to push.
// The desktop verifier launches Electron under Xvfb, which workspace-write blocks
// ("Check failed: . shutdown: Operation not permitted"); other verifier kinds stay sandboxed.
const SANDBOX = { implement: 'danger-full-access', verify: 'workspace-write', design: 'workspace-write' }
const VERIFY_SANDBOX = { desktop: 'danger-full-access' }

// On a Linux orchestration host the workspace-write sandbox also blocks child processes
// and local socket listeners (EPERM) that the full test suite needs, so every verifier
// kind runs with full access there.
export function codexSandbox(role, kind, platform = process.platform) {
  if (role === 'verify' && platform === 'linux') return 'danger-full-access'
  return (role === 'verify' && VERIFY_SANDBOX[kind]) || SANDBOX[role]
}

export async function launchAgent(ctx, { agent, label, cwd, prompt, role, kind, minutes, schemaPath, addDirs: extraDirs = [] }) {
  mkdirSync(ctx.logs, { recursive: true })
  const logPath = join(ctx.logs, `${label}.log`)
  const startedAt = new Date().toISOString()
  const model = resolveAgentModel(ctx.roles, { agent, role })
  const job = { agent, logPath, startedAt, deadlineAt: deadlineAt(startedAt, minutes), model }
  if (isCloud(agent)) {
    await prepareLaunch(ctx)
    const { sessionId, url } = await launchCloud({ root: ctx.root, launchWorktree: ctx.launchWorktree, prompt, logPath, model })
    return { ...job, sessionId, url }
  }
  if (!slotFree(ctx, agent)) return null
  if (agent === 'claude-local') {
    const outPath = join(ctx.logs, `${label}.out.json`)
    const { pid } = launchClaude({ cwd, prompt, logPath, outPath, schemaPath, addDirs: extraDirs, model })
    ctx.sem.acquire(label, pid)
    return { ...job, pid, outPath }
  }
  const outPath = join(ctx.logs, `${label}.out`)
  const codexBin = resolveCodexBin(ctx.root, { override: ctx.roles.codexBin })
  const addDirs = [...NODE_MODULES.map((rel) => join(ctx.root, rel)).filter((dir) => existsSync(dir)), ...extraDirs]
  const { pid } = launchCodex({ codexBin, cwd, prompt, logPath, outPath, sandbox: codexSandbox(role, kind), schemaPath, addDirs, model })
  ctx.sem.acquire(label, pid)
  return { ...job, pid, outPath }
}

export function releaseSlot(ctx, pid) {
  if (pid) ctx.sem.release(pid)
}
