import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { restoreBuild, saveBuild } from './build-cache.mjs'
import { git, sh } from './runtime.mjs'

// Spec and break judge runner-captured evidence; the sandboxed reviewer cannot launch Electron or e2e.
export const REVIEW_KINDS = ['spec', 'break']
export const MAX_REQUESTS = 3
const REQUEST_TIMEOUT_MS = 10 * 60_000
const SANDBOX_LAUNCH = /\bEPERM\b|\bSIGABRT\b|electron[^\n]*(?:launch|start|spawn|crash|abort)/i

const E2E_CMD = /playwright|e2e|verify-cli|run verify\b|electron/i

// ENGRAM_HIDDEN keeps e2e windows and notifications off the host, but product code reads it too, so unit commands must not see it.
export const hiddenUnset = (cmd) => (E2E_CMD.test(cmd) ? [] : ['ENGRAM_HIDDEN'])

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

export const DESKTOP_BUILD = 'pnpm --filter desktop build'
// The rest of a `&&` chain once the desktop build step is taken out, or null when the chain does not build.
export function withoutBuild(cmd) {
  const parts = cmd.split('&&').map((p) => p.trim())
  return parts.includes(DESKTOP_BUILD) ? parts.filter((p) => p !== DESKTOP_BUILD).join(' && ') : null
}

// `pnpm --filter <pkg> exec vitest run <path>` runs in the package dir, where the root vitest projects
// (whose includes are repo-relative) match no file; rewrite it to the root `unit` project with repo-relative paths.
const WORKSPACE_DIRS = { desktop: 'apps/desktop', core: 'packages/core' }
const FILTERED_VITEST = /^pnpm\s+(?:--filter[=\s]|-F\s*)(\S+)\s+exec\s+vitest\s+run(?=\s|$)(.*)$/
export function rootVitest(cmd) {
  return cmd.split('&&').map((part) => {
    const m = FILTERED_VITEST.exec(part.trim())
    const dir = m && WORKSPACE_DIRS[m[1].replace(/^@engram\//, '')]
    if (!dir || /(?:^|\s)--project\b/.test(m[2])) return part
    const args = m[2].trim().split(/\s+/).filter(Boolean)
    const paths = args.map((a) => (!a.startsWith('-') && a.includes('/') ? `${dir}/${a.replace(/^\.\//, '')}` : a))
    const lead = part.match(/^\s*/)[0]
    const tail = part.match(/\s*$/)[0]
    return `${lead}pnpm exec vitest run --project unit ${(args.some((a) => !a.startsWith('-')) ? paths : [dir, ...paths]).join(' ')}${tail}`
  }).join('&&')
}

/** Runs commands in a worktree outside the sandbox, one log each; the desktop build runs once (or comes from the build cache) and a failed build fails every command needing it. */
export async function runCommands(worktree, name, commands, timeoutMs, run = sh) {
  mkdirSync(join(worktree, 'orchestration/logs'), { recursive: true })
  const exec = async (id, cmd, env) => {
    const logPath = `orchestration/logs/${name}-${id.replace(/\W+/g, '_')}.log`
    const { code, out } = await run(worktree, 'sh', ['-c', cmd], { logPath: join(worktree, logPath), env, unset: hiddenUnset(cmd), timeoutMs })
    return { exit: code, logPath, tail: outputTail(out), screenshots: screenshots(out) }
  }
  // A build cached for this tree is restored instead of rebuilt; a miss builds once and fills the cache.
  const buildOnce = async () => {
    const cached = await restoreBuild(worktree)
    if (cached) {
      const logPath = `orchestration/logs/${name}-desktop-build.log`
      const tail = `desktop build restored from ${cached}`
      writeFileSync(join(worktree, logPath), `${tail}\n`)
      return { exit: 0, logPath, tail, screenshots: [] }
    }
    const built = await exec('desktop-build', DESKTOP_BUILD)
    if (built.exit === 0) await saveBuild(worktree)
    return built
  }
  let build = null
  const results = []
  for (const { cmd: asWritten, env, ...rest } of commands) {
    const cmd = rootVitest(asWritten)
    const after = withoutBuild(cmd)
    if (after !== null) build ??= await buildOnce()
    const ran = after === null ? await exec(rest.id, cmd, env) : build.exit !== 0 || !after ? build : await exec(rest.id, after, env)
    results.push({ ...rest, cmd, ...ran })
  }
  return results
}

/** Runs the reviewer's requested commands in its worktree outside the sandbox, one log each. */
export const runRequests = (worktree, name, requests, run = sh) =>
  runCommands(worktree, name, requests.map(({ cmd, why = '' }, i) => ({ id: `request${i + 1}`, cmd, why })), REQUEST_TIMEOUT_MS, run)

/** Spec and break launch only after the runner-run tests lane passed; a cloud lane (no runner results by design) does not gate. */
export function testsGate(kinds, testsJob) {
  if (!kinds.includes('tests')) return 'go'
  if (testsJob && !testsJob.results) return testsJob.sessionId || testsJob.verdictBranch ? 'go' : 'wait'
  if (!testsJob) return 'wait'
  return testsJob.results.every((r) => r.exit === 0) ? 'go' : 'fail'
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
