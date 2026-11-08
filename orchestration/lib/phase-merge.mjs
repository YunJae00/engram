import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fetchBranch, push, revert, squashMerge } from './git.mjs'
import { isTerminal, transition } from './ledger.mjs'
import { integrationScenarios, nextRevert, suggestBump } from './loop.mjs'
import { cleanAttempt, dropBranch } from './phase-verify.mjs'
import { attemptRef, git, isCloud, note, prepareNext, readJsonOrNull, save, sh, syncBaseBranch } from './runtime.mjs'
import { integrationBase, integrationCommands, integrationEnv, integrationTier, tierScenarios } from './tier.mjs'
import { roleMinutes } from './timebox.mjs'

export async function mergeVerified(ctx, ledger) {
  for (const item of ledger.items.filter((i) => i.state === 'verified')) {
    const winner = item.attempts.find((a) => a.outcome === 'pass')
    if (isCloud(winner.implementer)) await fetchBranch(ctx.opts, winner.branch)
    const worktree = await prepareNext(ctx)
    try {
      item.mergeSha = await squashMerge(ctx.opts, worktree, attemptRef(ctx, winner), item.title)
      await push(ctx.opts, worktree, ctx.roles.baseBranch)
    } catch (error) {
      delete item.mergeSha
      await git(worktree, 'reset', '--hard').catch(() => '')
      item.reason = `merge failed: ${String(error.message).slice(0, 200)}`
      transition(item, 'needs_human')
      note(ctx, item.id, 'merge', 'needs_human', item.reason, winner.branch)
      save(ctx, ledger)
      continue
    }
    for (const attempt of item.attempts) await cleanAttempt(ctx, item, attempt)
    await dropBranch(ctx, winner)
    transition(item, 'merged')
    note(ctx, item.id, 'merge', 'merged', `squash of attempt ${winner.n} into ${ctx.roles.baseBranch}`, item.mergeSha)
    save(ctx, ledger)
  }
}

export const QUIET_HOST = { ENGRAM_QUIET_HOST: '1' }
const QUIET_NOTE = 'ENGRAM_QUIET_HOST=1, host focus specs skipped'

export const scenarioCommand = (scenario, built) => ['scripts/verify-cli.mjs', scenario, ...(built ? [] : ['--build'])]

export const batchIdle = (ledger) => ledger.items.length > 0 && ledger.items.every((i) => isTerminal(i.state) || i.state === 'merged')
export const integrationFinished = (ledger) => ['passed', 'failed'].includes(ledger.integration?.state)

export function resetIntegration(ledger) {
  if (!ledger.integration) return (ledger.integration = { state: 'pending' })
  const { history = [], ...previous } = ledger.integration
  ledger.integration = { state: 'pending', history: [...history, previous] }
  return ledger.integration
}

async function latestRun(ctx) {
  const { code, out } = await sh(ctx.root, 'gh', [
    'run', 'list', '--workflow', 'ci.yml', '--branch', ctx.roles.baseBranch, '--event', 'workflow_dispatch', '--limit', '1',
    '--json', 'databaseId,status,conclusion',
  ])
  if (code !== 0) return null
  return readJsonText(out)?.[0] ?? null
}

function readJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Item verification is cloud-only; these are the final local desktop smoke checks.
const releaseScenarios = (merged, tier) => tierScenarios(tier, integrationScenarios(merged), merged.length)

async function runCi(ctx, logPath, timeoutMs) {
  const before = await latestRun(ctx)
  const started = await sh(ctx.root, 'gh', ['workflow', 'run', 'ci.yml', '--ref', ctx.roles.baseBranch, '-f', 'native_only=true'], { logPath })
  if (started.code !== 0) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(30_000)
    const run = await latestRun(ctx)
    if (run && run.databaseId !== before?.databaseId && run.status === 'completed') {
      writeFileSync(logPath, `ci run ${run.databaseId}: ${run.conclusion}\n`, { flag: 'a' })
      return run.conclusion === 'success'
    }
  }
  writeFileSync(logPath, 'ci run did not complete before the deadline\n', { flag: 'a' })
  return false
}

async function runChecks(ctx, merged, logPath) {
  const worktree = await prepareNext(ctx)
  const timeoutMs = roleMinutes(ctx.roles, 'integrate') * 60_000
  const run = (cmd, args) => sh(worktree, cmd, args, { logPath, timeoutMs, env: QUIET_HOST })
  if ((await run('pnpm', ['install', '--frozen-lockfile'])).code !== 0) return ['install']
  const failed = []
  const tier = ctx.integrationTier ?? integrationTier(ctx.roles)
  const counts = await Promise.all(merged.filter((i) => i.mergeSha).map(async (i) => {
    const out = await sh(worktree, 'git', ['rev-list', '--count', i.mergeSha])
    return { sha: i.mergeSha, count: out.code === 0 ? Number(out.out) : NaN }
  }))
  const base = integrationBase(counts, `${ctx.opts.remote}/${ctx.roles.mainBranch}`)
  const env = integrationEnv(tier, base)
  writeFileSync(logPath, `integration tier ${tier}${env.ENGRAM_CHECK_BASE ? `; ENGRAM_CHECK_BASE=${env.ENGRAM_CHECK_BASE}` : ''}\n`, { flag: 'a' })
  for (const [cmd, args] of integrationCommands(tier)) {
    if ((await sh(worktree, cmd, args, { logPath, timeoutMs, env: { ...QUIET_HOST, ...env } })).code !== 0) return [tier === 'full' ? 'verify' : args.join(' ')]
  }
  for (const scenario of releaseScenarios(merged, tier)) {
    const built = existsSync(join(worktree, 'apps/desktop/out/main/index.js'))
    const cli = scenarioCommand(scenario, built)
    const result = await sh(worktree, process.execPath, cli, { logPath, timeoutMs, env: QUIET_HOST })
    if (result.code !== 0) failed.push(scenario)
  }
  if (failed.length) return failed
  if (process.env.ENGRAM_SKIP_CI === '1') return []
  return (await runCi(ctx, logPath, timeoutMs)) ? [] : ['ci']
}

export async function integrate(ctx, ledger) {
  const merged = () => ledger.items.filter((i) => i.state === 'merged')
  if (merged().length === 0) return
  const replayed = ledger.items.filter((i) => i.state === 'merged' && i.mergeSha)
  if (replayed.length === 1 && !(await sh(ctx.nextWorktree, 'git', ['cat-file', '-e', `${replayed[0].mergeSha}^{commit}`])).code) {
    const worktree = await prepareNext(ctx)
    await sh(worktree, 'git', ['diff', '--quiet', replayed[0].mergeSha, 'HEAD']).then(({code}) => { if (code !== 0) throw new Error('restored merge differs from integration worktree') })
  } else await syncBaseBranch(ctx, 'integrate')
  mkdirSync(ctx.logs, { recursive: true })
  const logPath = join(ctx.logs, `integration-${ledger.batch}.log`)
  const history = ledger.integration?.history
  ledger.integration = { state: 'running', startedAt: new Date().toISOString(), logPath, ...(history ? { history } : {}) }
  note(ctx, 'batch', 'integrate', 'running', `${merged().length} merged item(s); ${QUIET_NOTE}`, logPath)
  save(ctx, ledger)
  const cap = merged().length
  let reverts = 0
  for (;;) {
    const current = merged()
    if (current.length === 0) {
      ledger.integration.state = 'failed'
      note(ctx, 'batch', 'integrate', 'failed', 'every merged item was reverted')
      break
    }
    const failed = await runChecks(ctx, current, logPath)
    if (failed.length === 0) {
      for (const item of current) {
        transition(item, 'integrated')
        note(ctx, item.id, 'integrate', 'integrated', 'integration passed', logPath)
      }
      ledger.integration.state = 'passed'
      break
    }
    ledger.integration.failedScenarios = failed
    const target = nextRevert(failed, current, reverts, cap)
    if (!target) {
      ledger.integration.state = 'failed'
      note(ctx, 'batch', 'integrate', 'failed', reverts >= cap ? `revert cap ${cap} reached` : 'no merged item names a failed check', failed.join(','))
      break
    }
    const worktree = await prepareNext(ctx)
    try {
      target.revertSha = await revert(ctx.opts, worktree, target.mergeSha, `revert ${target.title}`)
      await push(ctx.opts, worktree, ctx.roles.baseBranch)
    } catch (error) {
      delete target.revertSha
      await git(worktree, 'revert', '--abort').catch(() => git(worktree, 'reset', '--hard').catch(() => ''))
      ledger.integration.state = 'failed'
      note(ctx, target.id, 'integrate', 'revert failed', String(error.message).slice(0, 200), target.mergeSha)
      break
    }
    reverts += 1
    target.reason = `integration failed: ${failed.join(', ')}`
    transition(target, 'reverted')
    note(ctx, target.id, 'integrate', 'reverted', target.reason, target.revertSha)
    save(ctx, ledger)
  }
  ledger.integration.finishedAt = new Date().toISOString()
  const failedNames = (ledger.integration.failedScenarios ?? []).join(',')
  note(ctx, 'batch', 'integrate', ledger.integration.state, `${QUIET_NOTE}${failedNames ? `; failed: ${failedNames}` : ''}`, logPath)
  save(ctx, ledger)
}

export const attemptMinutes = (a) => (a.startedAt && a.finishedAt ? Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 6000) / 10 : '')

const row = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`

function evidenceRows(ctx, item) {
  const winner = item.attempts.find((a) => a.outcome === 'pass')
  if (!winner) return []
  const latest = new Map()
  for (const ref of item.verdicts.filter((v) => v.attempt === winner.n)) latest.set(ref.kind, ref)
  return [...latest.values()].flatMap((ref) => (readJsonOrNull(join(ctx.root, ref.path))?.evidence ?? [])
    .map((e) => row([item.id, e.criterion, ref.kind, `\`${e.cmd}\``, e.result, e.logPath])))
}

export function writeSummary(ctx, ledger) {
  const changed = ledger.items.filter((i) => ['merged', 'integrated', 'released'].includes(i.state))
  const excluded = ledger.items.filter((i) => ['blocked', 'needs_human', 'reverted'].includes(i.state))
  const integration = ledger.integration ?? { state: 'pending' }
  const lines = [
    `# Summary ${ledger.batch}`,
    '',
    `Integration: ${integration.state}${integration.failedScenarios?.length ? ` (failed: ${integration.failedScenarios.join(', ')})` : ''}`,
    `Integration ran with ${QUIET_NOTE}.`,
    ...(integration.history ?? []).map((h, i) => `Earlier run ${i + 1}: ${h.state}${h.failedScenarios?.length ? ` (failed: ${h.failedScenarios.join(', ')})` : ''}`),
    '',
    '## Changed items',
    row(['item', 'title', 'state', 'merge sha', 'bounces']),
    row(['---', '---', '---', '---', '---']),
    ...changed.map((i) => row([i.id, i.title, i.state, i.mergeSha, i.bounces])),
    '',
    '## Evidence per criterion',
    row(['item', 'criterion', 'verifier', 'command', 'result', 'log']),
    row(['---', '---', '---', '---', '---', '---']),
    ...changed.flatMap((i) => evidenceRows(ctx, i)),
    '',
    '## Excluded items',
    row(['item', 'state', 'reason']),
    row(['---', '---', '---']),
    ...excluded.map((i) => row([i.id, i.state, i.reason])),
    '',
    '## Attempts',
    row(['item', 'n', 'implementer', 'verifier', 'outcome', 'tokens', 'minutes']),
    row(['---', '---', '---', '---', '---', '---', '---']),
    ...ledger.items.flatMap((i) => i.attempts.map((a) => row([i.id, a.n, a.implementer, a.verifier, a.outcome, a.tokens, attemptMinutes(a)]))),
    '',
    `## Suggested release\n${changed.length ? suggestBump(changed) : 'none (nothing changed)'}`,
    '',
  ]
  const path = join(ctx.orch, 'reports', `summary-${ledger.batch}.md`)
  mkdirSync(join(ctx.orch, 'reports'), { recursive: true })
  writeFileSync(path, lines.join('\n'))
  note(ctx, 'batch', 'summary', 'written', `${changed.length} changed, ${excluded.length} excluded`, path)
  return path
}
