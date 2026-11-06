import { describe, expect, it } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { loadRoles } from './ledger.mjs'
import { verifyDecision } from './loop.mjs'
import { verifierPrompt, implementerPrompt } from './prompt.mjs'
import {
  DEFAULT_MINUTES, implementTimeout, maxLaunches, ownVerdict, roleMinutes, timedOut, timeoutVerdict, verdictBranch, verifierTick,
} from './timebox.mjs'

const roles = loadRoles(fileURLToPath(new URL('../..', import.meta.url)))
const sha = (c) => c.repeat(40)
const at = (iso) => new Date(iso)
const job = (over = {}) => ({ sessionId: 'session_a', tries: 1, deadlineAt: '2026-11-06T15:00:00.000Z', ...over })

describe('role deadlines', () => {
  it('ships 40 minutes for implementation and 20 per verifier kind', () => {
    expect(roleMinutes(roles, 'implement')).toBe(40)
    for (const kind of ['tests', 'spec', 'desktop', 'break']) expect(roleMinutes(roles, 'verify', kind)).toBe(20)
    expect(maxLaunches(roles)).toBe(2)
  })

  it('accepts a number, a per-kind map with default, or nothing', () => {
    expect(roleMinutes({ minutes: { verify: 7 } }, 'verify', 'break')).toBe(7)
    expect(roleMinutes({ minutes: { verify: { break: 30, default: 12 } } }, 'verify', 'break')).toBe(30)
    expect(roleMinutes({ minutes: { verify: { break: 30, default: 12 } } }, 'verify', 'spec')).toBe(12)
    expect(roleMinutes({ minutes: { verify: { break: 30 } } }, 'verify', 'spec')).toBe(DEFAULT_MINUTES.verify)
    expect(roleMinutes({}, 'implement')).toBe(DEFAULT_MINUTES.implement)
    expect(maxLaunches({ timeoutRelaunches: 0 })).toBe(1)
  })

  it('times out strictly after the deadline', () => {
    expect(timedOut('2026-11-06T15:00:00.000Z', at('2026-11-06T15:00:00.000Z'))).toBe(false)
    expect(timedOut('2026-11-06T15:00:00.000Z', at('2026-11-06T15:00:01.000Z'))).toBe(true)
    expect(timedOut(undefined, at('2030-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('implementation timeout', () => {
  it('relaunches once, then records a timeout', () => {
    expect(implementTimeout({}, roles)).toEqual({ action: 'relaunch', launch: 2 })
    expect(implementTimeout({ launch: 2 }, roles)).toEqual({ action: 'timeout', launch: 2 })
    expect(implementTimeout({}, { timeoutRelaunches: 0 })).toEqual({ action: 'timeout', launch: 1 })
  })
})

describe('verifier tick', () => {
  const before = at('2026-11-06T14:59:00Z')
  const after = at('2026-11-06T15:01:00Z')

  it('waits until the deadline, then relaunches the first try and times out the second', () => {
    expect(verifierTick(job(), { produced: false, now: before, roles })).toBe('wait')
    expect(verifierTick(job(), { produced: false, now: after, roles })).toBe('relaunch')
    expect(verifierTick(job({ tries: 2 }), { produced: false, now: after, roles })).toBe('timeout')
  })

  it('collects a verdict that is already on the branch even past the deadline', () => {
    expect(verifierTick(job(), { produced: true, now: after, roles })).toBe('collect')
  })

  it('never waits forever on a cloud session, unlike the old jobFinished', () => {
    const stuck = job({ deadlineAt: '2026-11-06T13:00:00.000Z' })
    expect(verifierTick(stuck, { produced: false, now: at('2026-11-06T17:00:00Z'), roles })).not.toBe('wait')
  })

  it('collects a local process that exited before its deadline', () => {
    expect(verifierTick(job({ sessionId: undefined, pid: 1 }), { produced: false, exited: true, now: before, roles })).toBe('collect')
  })
})

describe('stale verdicts', () => {
  const expected = { id: 'x', attempt: 1, kind: 'break', headSha: sha('a') }
  const verdict = { ...expected, verdict: 'pass', evidence: [{ criterion: 'c', cmd: 'true', logPath: 'l', result: 'ok' }], findings: [] }

  it('gives every launch its own verdict branch', () => {
    expect(verdictBranch('x-1-break')).toBe('orch/verdicts/x-1-break')
    expect(verdictBranch('x-1-break', 1)).toBe('orch/verdicts/x-1-break')
    expect(verdictBranch('x-1-break', 2)).toBe('orch/verdicts/x-1-break-r2')
  })

  it('accepts only a verdict for this item, attempt, kind and commit', () => {
    expect(ownVerdict(verdict, expected)).toBe(verdict)
    expect(ownVerdict({ ...verdict, headSha: sha('b') }, expected)).toBeNull()
    expect(ownVerdict({ ...verdict, attempt: 2 }, expected)).toBeNull()
    expect(ownVerdict({ ...verdict, kind: 'spec' }, expected)).toBeNull()
    expect(ownVerdict(null, expected)).toBeNull()
  })

  it('turns a final timeout into cannot_verify that is not retried again', () => {
    const timeout = timeoutVerdict(expected)
    expect(timeout).toMatchObject({ verdict: 'cannot_verify', headSha: sha('a'), evidence: [] })
    const byKind = { break: timeout, tests: { ...verdict, kind: 'tests' } }
    expect(verifyDecision(byKind, sha('a'), { break: 2, tests: 1 }, maxLaunches(roles)).action).toBe('needs_human')
    expect(verifyDecision(byKind, sha('a'), { break: 1, tests: 1 }, maxLaunches(roles))).toMatchObject({ action: 'retry', kinds: ['break'] })
  })
})

describe('prompts name the time budget and a fresh verdict branch', () => {
  const brief = { id: 'x', goal: 'g', criteria: [{ id: 'c', cmd: 'true', expect: 'exit 0' }], allowedFiles: ['scripts/**'], outOfScope: [] }

  it('tells a cloud verifier its minutes and to branch from the commit', () => {
    const text = verifierPrompt({
      persona: 'p', kind: 'break', brief, headSha: sha('a'), verdictPath: 'v.json', schemaText: '{}', cloud: true,
      verdictBranch: 'orch/verdicts/x-1-break-r2', minutes: 20,
    })
    expect(text).toContain('You have 20 minutes from launch.')
    expect(text).toContain(`new branch \`orch/verdicts/x-1-break-r2\` created from \`${sha('a')}\``)
    expect(text).not.toContain('existing remote verdict branch')
    expect(text).toContain('Do not rerun them')
  })

  it('tells an implementer its minutes and to push a partial report in time', () => {
    const text = implementerPrompt({ persona: 'p', rules: 'r', brief, branch: 'orch/x-1', baseBranch: 'next', reportPath: 'r.json', cloud: true, minutes: 40 })
    expect(text).toContain('You have 40 minutes from launch.')
    expect(text).toContain('status `partial` or `blocked`')
  })
})
