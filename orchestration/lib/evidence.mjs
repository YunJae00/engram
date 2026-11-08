import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, sh } from './runtime.mjs'

// Spec and break judge runner-captured evidence; the sandboxed reviewer cannot launch Electron or e2e.
export const REVIEW_KINDS = ['spec', 'break']
export const MAX_REQUESTS = 3
const REQUEST_TIMEOUT_MS = 10 * 60_000
const SANDBOX_LAUNCH = /\bEPERM\b|\bSIGABRT\b|electron[^\n]*(?:launch|start|spawn|crash|abort)/i

export const outputTail = (text, lines = 40, chars = 4000) => String(text ?? '').split('\n').slice(-lines).join('\n').slice(-chars)
export const screenshots = (text) => [...new Set(String(text ?? '').match(/[\w./-]+\.png\b/g) ?? [])]

// A cannot_verify with no finding whose stated reasons only blame the sandbox failing to start the app.
export function sandboxOnlyCannotVerify(verdict) {
  if (verdict?.verdict !== 'cannot_verify' || (verdict.findings ?? []).length) return false
  const reasons = (verdict.evidence ?? []).map((e) => e.result).filter((r) => !/^pass\b|deferred to integration/i.test(r ?? ''))
  return reasons.length > 0 && reasons.every((r) => SANDBOX_LAUNCH.test(r))
}

/** Commands the runner should run before rerunning this reviewer once, or null to accept the verdict. */
export function evidenceRound(verdict, kind, job) {
  if (!REVIEW_KINDS.includes(kind) || !verdict || !job?.worktree || job.evidenceRound) return null
  const asked = (Array.isArray(verdict.evidenceRequests) ? verdict.evidenceRequests : [])
    .filter((r) => typeof r?.cmd === 'string' && r.cmd.trim())
    .slice(0, MAX_REQUESTS)
  if (asked.length) return asked
  return sandboxOnlyCannotVerify(verdict) ? [] : null
}

/** Runs the reviewer's requested commands in its worktree outside the sandbox, one log each. */
export async function runRequests(worktree, name, requests, run = sh) {
  mkdirSync(join(worktree, 'orchestration/logs'), { recursive: true })
  const results = []
  for (const [i, { cmd, why = '' }] of requests.entries()) {
    const logPath = `orchestration/logs/${name}-request${i + 1}.log`
    const { code, out } = await run(worktree, 'sh', ['-c', cmd], { logPath: join(worktree, logPath), timeoutMs: REQUEST_TIMEOUT_MS })
    results.push({ id: `request${i + 1}`, cmd, why, exit: code, logPath, tail: outputTail(out), screenshots: screenshots(out) })
  }
  return results
}

/** Copies the tests lane's logs into a spec/break worktree and writes the diff there; returns what the prompt cites. */
export async function shareEvidence(ctx, worktree, name, testsJob, diff = (cwd) => git(cwd, 'diff', `${ctx.base}...HEAD`)) {
  const checks = testsJob?.results ?? []
  for (const r of checks) {
    const from = testsJob.worktree ? join(testsJob.worktree, r.logPath) : null
    if (!from || !existsSync(from)) continue
    mkdirSync(dirname(join(worktree, r.logPath)), { recursive: true })
    copyFileSync(from, join(worktree, r.logPath))
  }
  const diffPath = `orchestration/logs/${name}-diff.patch`
  mkdirSync(join(worktree, 'orchestration/logs'), { recursive: true })
  writeFileSync(join(worktree, diffPath), `${await diff(worktree)}\n`)
  return { checks, diffPath }
}
