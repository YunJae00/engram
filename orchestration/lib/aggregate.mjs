import { validate } from './validate.mjs'

const hasRepro = (finding) => typeof finding.reproCmd === 'string' && finding.reproCmd.trim() !== ''

function splitFindings(verdict) {
  const findings = Array.isArray(verdict.findings) ? verdict.findings : []
  const followups = findings
    .filter((finding) => !hasRepro(finding))
    .map(({ file, line, claim }) => ({ item: verdict.id, file, line, claim }))
  return { kept: findings.filter(hasRepro), followups, total: findings.length }
}

export function checkVerdict(verdict, schema) {
  const { kept, followups } = splitFindings(verdict)
  const errors = validate(schema, { ...verdict, findings: kept })
  if (errors.length) return { valid: false, reason: errors.join('; '), followups }
  if (verdict.verdict === 'pass' && verdict.evidence.length === 0) {
    return { valid: false, reason: 'pass without evidence', followups }
  }
  return { valid: true, reason: null, followups }
}

function effective(verdict) {
  const { kept, total } = splitFindings(verdict)
  if (verdict.verdict === 'pass' && verdict.evidence.length === 0) return 'cannot_verify'
  // A fail whose every finding lacks a repro is not blocking; those findings become followups.
  if (verdict.verdict === 'fail' && total > 0 && kept.length === 0) return 'pass'
  return verdict.verdict
}

// What the next implementer or designer must be told: reproducible findings, or the evidence of a fail that has none.
export function blockingFindings(verdicts) {
  const seen = new Set()
  return verdicts
    .filter((verdict) => verdict.verdict === 'fail')
    .flatMap((verdict) => {
      const { kept, total } = splitFindings(verdict)
      if (total > 0) return kept.map(({ file, line, claim, reproCmd }) => ({ where: `${file}:${line}`, claim, reproCmd }))
      return verdict.evidence.map(({ criterion, cmd, result }) => ({ where: `criterion ${criterion}`, claim: result, reproCmd: cmd }))
    })
    .filter(({ where, claim }) => !seen.has(`${where}\n${claim}`) && seen.add(`${where}\n${claim}`))
}

export function aggregate(verdicts, tipSha) {
  const followups = verdicts.flatMap((verdict) => splitFindings(verdict).followups)
  if (verdicts.some((verdict) => verdict.headSha !== tipSha)) return { result: 'stale', followups }
  const results = verdicts.map(effective)
  if (results.includes('fail')) return { result: 'fail', followups }
  if (results.length === 0 || results.includes('cannot_verify')) return { result: 'cannot_verify', followups }
  return { result: 'pass', followups }
}
