import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { aggregate, checkVerdict } from './aggregate.mjs'

const schema = JSON.parse(readFileSync(new URL('../schemas/verdict.schema.json', import.meta.url), 'utf8'))
const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const evidence = [{ criterion: 'c1', cmd: 'npm test', logPath: 'orchestration/logs/x.log', result: 'exit 0' }]
const verdict = (kind, value, extra = {}) => ({
  id: 'fix-x', attempt: 1, kind, verdict: value, headSha: SHA, evidence, findings: [], ...extra,
})
const finding = { file: 'a.ts', line: 3, claim: 'crashes on empty input', reproCmd: 'node -e "x()"' }
const loose = { file: 'b.ts', line: 7, claim: 'naming is odd' }

describe('checkVerdict', () => {
  it('accepts a schema-valid pass with evidence', () => {
    expect(checkVerdict(verdict('tests', 'pass'), schema)).toEqual({ valid: true, reason: null, followups: [] })
  })

  it('rejects a pass with empty evidence', () => {
    const result = checkVerdict(verdict('tests', 'pass', { evidence: [] }), schema)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('pass without evidence')
  })

  it('rejects a schema violation', () => {
    const result = checkVerdict(verdict('tests', 'maybe'), schema)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('$.verdict')
  })

  it('moves a finding without reproCmd to followups instead of failing validation', () => {
    const result = checkVerdict(verdict('spec', 'fail', { findings: [finding, loose] }), schema)
    expect(result.valid).toBe(true)
    expect(result.followups).toEqual([{ item: 'fix-x', file: 'b.ts', line: 7, claim: 'naming is odd' }])
  })
})

describe('aggregate', () => {
  it('passes when every verdict passes', () => {
    const all = [verdict('tests', 'pass'), verdict('spec', 'pass'), verdict('break', 'pass')]
    expect(aggregate(all, SHA)).toEqual({ result: 'pass', followups: [] })
  })

  it('fails when any verdict fails with a reproducible finding', () => {
    const all = [verdict('tests', 'pass'), verdict('spec', 'pass'), verdict('break', 'fail', { findings: [finding] })]
    expect(aggregate(all, SHA).result).toBe('fail')
  })

  it('fails on a tests fail backed only by evidence', () => {
    expect(aggregate([verdict('tests', 'fail'), verdict('spec', 'pass')], SHA).result).toBe('fail')
  })

  it('does not block on a fail whose findings all lack reproCmd', () => {
    const all = [verdict('tests', 'pass'), verdict('spec', 'fail', { findings: [loose] })]
    expect(aggregate(all, SHA)).toEqual({
      result: 'pass',
      followups: [{ item: 'fix-x', file: 'b.ts', line: 7, claim: 'naming is odd' }],
    })
  })

  it('returns cannot_verify when no fail but a verifier could not verify', () => {
    expect(aggregate([verdict('tests', 'pass'), verdict('break', 'cannot_verify')], SHA).result).toBe('cannot_verify')
    expect(aggregate([verdict('tests', 'pass', { evidence: [] })], SHA).result).toBe('cannot_verify')
    expect(aggregate([], SHA).result).toBe('cannot_verify')
  })

  it('is stale when any verdict was taken at another sha', () => {
    const all = [verdict('tests', 'pass'), verdict('spec', 'fail', { headSha: OTHER, findings: [finding] })]
    expect(aggregate(all, SHA).result).toBe('stale')
  })
})
