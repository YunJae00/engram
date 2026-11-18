
export const DEFAULT_MINUTES = { design: 15, implement: 40, verify: 20, integrate: 60 }

export function roleMinutes(roles, phase, kind) {
  const value = roles?.minutes?.[phase]
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') return value[kind] ?? value.default ?? DEFAULT_MINUTES[phase]
  return DEFAULT_MINUTES[phase]
}

export const maxLaunches = (roles) => 1 + (roles?.timeoutRelaunches ?? 1)

export const timedOut = (deadlineIso, now = new Date()) => Boolean(deadlineIso) && now.getTime() > Date.parse(deadlineIso)

export function implementTimeout(attempt, roles) {
  const launch = attempt.launch ?? 1
  return launch < maxLaunches(roles) ? { action: 'relaunch', launch: launch + 1 } : { action: 'timeout', launch }
}

export function verifierTick(job, { produced, exited = false, now = new Date(), roles }) {
  if (produced) return 'collect'
  if (timedOut(job.deadlineAt, now)) return (job.tries ?? 1) < maxLaunches(roles) ? 'relaunch' : 'timeout'
  return exited ? 'collect' : 'wait'
}

export const verdictBranch = (name, tries = 1) => `orch/verdicts/${name}${tries > 1 ? `-r${tries}` : ''}`

export function ownVerdict(raw, { id, attempt, kind, headSha }) {
  if (!raw || typeof raw !== 'object') return null
  return raw.id === id && raw.attempt === attempt && raw.kind === kind && raw.headSha === headSha ? raw : null
}

export function timeoutVerdict({ id, attempt, kind, headSha }) {
  return { id, attempt, kind, verdict: 'cannot_verify', headSha, evidence: [], findings: [] }
}
