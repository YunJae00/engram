import { aggregate } from './aggregate.mjs'
import { culprits, revertPlan } from './bisect.mjs'
import { rung } from './ledger.mjs'

export function deadlineAt(startIso, minutes) {
  return new Date(Date.parse(startIso) + minutes * 60_000).toISOString()
}

export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

export const matchesAny = (path, globs) => globs.some((glob) => globToRegExp(glob).test(path))

export function machineCheck({ itemId, report, reportErrors, changed, allowedFiles, reportPath, tip, parent }) {
  if (!report) return { ok: false, reason: 'no report on the branch' }
  if (reportErrors.length) return { ok: false, reason: `report invalid: ${reportErrors.join('; ')}` }
  if (report.id !== itemId) return { ok: false, reason: `report id ${report.id} is not ${itemId}` }
  if (report.status !== 'done') return { ok: false, reason: `report status ${report.status}` }
  const code = changed.filter((file) => file !== reportPath)
  if (code.length === 0) return { ok: false, reason: 'empty diff' }
  const outside = code.filter((file) => !matchesAny(file, allowedFiles))
  if (outside.length) return { ok: false, reason: `files outside allowedFiles: ${outside.join(', ')}` }
  if (report.headSha !== tip && report.headSha !== parent) {
    return { ok: false, reason: `report headSha ${report.headSha} is neither tip ${tip} nor its parent` }
  }
  return { ok: true, reason: null }
}

export const lineage = (agent) => (agent.startsWith('claude') ? 'claude' : 'codex')

export function plannedAttempts(item, roles, hard) {
  const base = rung(item, roles)
  if (!base) return []
  if (!hard || item.bounces === 0) return [base]
  const claude = lineage(base.implementer) === 'claude'
    ? base.implementer
    : (roles.ladder[item.area].find((r) => lineage(r.implementer) === 'claude')?.implementer ?? 'claude-local')
  return [
    { implementer: claude, verifier: base.verifier },
    { implementer: base.implementer, verifier: base.verifier },
  ]
}

export function roundOutcome(attempts) {
  const passed = attempts
    .filter((a) => a.outcome === 'pass')
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
  const live = attempts.filter((a) => !a.outcome)
  if (passed.length) return { action: 'win', winner: passed[0], losers: [...live, ...passed.slice(1)] }
  return live.length ? { action: 'wait' } : { action: 'bounce' }
}

export function verifyDecision(byKind, tip, tries, maxTries = 2) {
  const verdicts = Object.values(byKind)
  const { result, followups } = aggregate(verdicts, tip)
  if (result !== 'cannot_verify') return { action: result === 'stale' ? 'reverify' : result, followups }
  const retry = Object.entries(byKind)
    .filter(([kind, v]) => aggregate([v], tip).result === 'cannot_verify' && (tries[kind] ?? 1) < maxTries)
    .map(([kind]) => kind)
  return retry.length ? { action: 'retry', kinds: retry, followups } : { action: 'needs_human', followups }
}

export function nextRevert(failedScenarios, merged, revertsDone, cap) {
  if (revertsDone >= cap || merged.length === 0) return null
  const known = culprits(failedScenarios, merged)
  if (known.length === 0) return null
  const plan = revertPlan(merged, known)
  return merged.find((item) => item.id === plan[0].id) ?? null
}

export const designPath = (id, line) => `orchestration/designs/${id}-${line}.md`
export const rejectedDesignPath = (id) => designPath(id, 'rejected')

// One FAIL can be a slip in the implementation; a second FAIL under the same design counts against the design.
export const needsRedesign = (bounces, hasDesign) => hasDesign && bounces >= 2

export function designLocations(root, worktree, id, line) {
  const target = `${root.replace(/\/$/, '')}/${designPath(id, line)}`
  return { target, candidates: [target, `${worktree.replace(/\/$/, '')}/${designPath(id, line)}`] }
}

export const findDesign = (candidates, exists) => candidates.find((path) => exists(path)) ?? null

export function pickDesign(designs, deadlinePassed) {
  if (!deadlinePassed || designs.length === 0) return null
  return [...designs].sort((a, b) => a.mtimeMs - b.mtimeMs)[0].lineage
}

export function bumpVersion(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (![major, minor, patch].every(Number.isInteger)) throw new Error(`cannot bump version ${version}`)
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump ${kind}`)
}

export function suggestBump(items) {
  return items.some((item) => /^(add|introduce|support)\b/.test(item.title)) ? 'minor' : 'patch'
}

const VERIFY_SCENARIO = /(?:^|\s)scripts\/verify-cli\.mjs\s+([a-z0-9-]+)/

// Names in `scenarios`, plus any criterion whose command is `node scripts/verify-cli.mjs <scenario>`.
export function briefScenarios(brief) {
  const named = brief?.scenarios ?? []
  const fromCommands = (brief?.criteria ?? []).flatMap((criterion) => {
    const match = VERIFY_SCENARIO.exec(criterion.cmd ?? '')
    return match ? [match[1]] : []
  })
  return [...new Set([...named, ...fromCommands])]
}

export function verifierKindsFor(roles, brief) {
  const kinds = [...(roles.verifierKinds ?? [])]
  if (briefScenarios(brief).length > 0 && !kinds.includes('desktop')) kinds.push('desktop')
  return kinds
}

export function integrationScenarios(merged) {
  return [...new Set(['boot', ...merged.flatMap((item) => briefScenarios(item))])]
}
