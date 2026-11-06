import { describe, expect, it } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { loadRoles } from './ledger.mjs'
import {
  bumpVersion, deadlineAt, designLocations, findDesign, globToRegExp, integrationScenarios, isStalled, machineCheck, nextRevert, pickDesign,
  plannedAttempts, roundOutcome, suggestBump, verifyDecision,
} from './loop.mjs'
import { release, setVersion } from './release.mjs'
import { linkNodeModules } from './runtime.mjs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { attemptMinutes, batchIdle, integrationFinished, QUIET_HOST, resetIntegration } from './phase-merge.mjs'
import { validate } from './validate.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roles = loadRoles(fileURLToPath(new URL('../..', import.meta.url)))
const sha = (c) => c.repeat(40)
const item = (over = {}) => ({ id: 'x', area: 'ts', bounces: 0, ...over })

describe('bounce ladder', () => {
  it('takes one rung per bounce for easy items', () => {
    expect(plannedAttempts(item(), roles, false)).toEqual([{ implementer: 'claude-cloud', verifier: 'codex-local' }])
    expect(plannedAttempts(item({ bounces: 2 }), roles, false)).toEqual([{ implementer: 'codex-local', verifier: 'claude-local' }])
    expect(plannedAttempts(item({ bounces: 3 }), roles, false)).toEqual([])
  })

  it('runs claude and codex at once for hard items after the first FAIL', () => {
    expect(plannedAttempts(item(), roles, true)).toHaveLength(1)
    expect(plannedAttempts(item({ bounces: 1 }), roles, true)).toEqual([
      { implementer: 'claude-cloud', verifier: 'codex-local' },
      { implementer: 'codex-local', verifier: 'claude-local' },
    ])
    expect(plannedAttempts(item({ area: 'native', bounces: 2 }), roles, true)).toEqual([
      { implementer: 'claude-local', verifier: 'codex-local' },
      { implementer: 'codex-local', verifier: 'claude-local' },
    ])
    expect(plannedAttempts(item({ area: 'native', bounces: 3 }), roles, true)).toEqual([])
  })
})

describe('machine checks', () => {
  const ok = {
    itemId: 'x', report: { id: 'x', status: 'done', headSha: sha('a') }, reportErrors: [], reportPath: 'orchestration/reports/x.json',
    changed: ['scripts/check-quick.mjs', 'orchestration/reports/x.json'], allowedFiles: ['scripts/**'], tip: sha('b'), parent: sha('a'),
  }

  it('accepts a change inside the allowed files with headSha at the parent or tip', () => {
    expect(machineCheck(ok)).toEqual({ ok: true, reason: null })
    expect(machineCheck({ ...ok, report: { ...ok.report, headSha: sha('b') } }).ok).toBe(true)
  })

  it('rejects empty diffs, outside files, wrong sha, bad reports', () => {
    expect(machineCheck({ ...ok, changed: ['orchestration/reports/x.json'] }).reason).toBe('empty diff')
    expect(machineCheck({ ...ok, changed: ['scripts/a.mjs', 'apps/desktop/src/main/ipc.ts'] }).reason).toMatch(/outside allowedFiles: apps\/desktop\/src\/main\/ipc.ts/)
    expect(machineCheck({ ...ok, report: { ...ok.report, headSha: sha('c') } }).reason).toMatch(/neither tip/)
    expect(machineCheck({ ...ok, report: null }).ok).toBe(false)
    expect(machineCheck({ ...ok, reportErrors: ['$.id: missing'] }).reason).toMatch(/report invalid/)
    expect(machineCheck({ ...ok, report: { ...ok.report, status: 'blocked' } }).reason).toBe('report status blocked')
    expect(machineCheck({ ...ok, report: { ...ok.report, id: 'y' } }).ok).toBe(false)
  })

  it('matches globs per path segment', () => {
    expect(globToRegExp('apps/desktop/src/**').test('apps/desktop/src/main/ipc.ts')).toBe(true)
    expect(globToRegExp('packages/*/src/*.ts').test('packages/core/src/a.ts')).toBe(true)
    expect(globToRegExp('packages/*/src/*.ts').test('packages/core/src/deep/a.ts')).toBe(false)
    expect(globToRegExp('packages/**/test/*.ts').test('packages/test/a.ts')).toBe(true)
    expect(globToRegExp('scripts/check-quick.mjs').test('scripts/check-quickXmjs')).toBe(false)
  })
})

describe('stall detection', () => {
  it('stalls only past the deadline without a report', () => {
    const deadline = deadlineAt('2026-11-05T10:00:00.000Z', 45)
    expect(deadline).toBe('2026-11-05T10:45:00.000Z')
    expect(isStalled(deadline, new Date('2026-11-05T10:44:59Z'), false)).toBe(false)
    expect(isStalled(deadline, new Date('2026-11-05T10:45:01Z'), false)).toBe(true)
    expect(isStalled(deadline, new Date('2026-11-05T11:00:00Z'), true)).toBe(false)
  })
})

describe('hard item winner', () => {
  it('first verified attempt wins and live ones lose', () => {
    const a = { n: 2, outcome: 'pass', finishedAt: '2026-11-05T10:20:00Z' }
    const b = { n: 3, finishedAt: '2026-11-05T10:10:00Z' }
    expect(roundOutcome([{ n: 1, outcome: 'fail' }, a, b])).toEqual({ action: 'win', winner: a, losers: [b] })
  })

  it('waits while any attempt is live and bounces when all failed', () => {
    expect(roundOutcome([{ n: 2, outcome: 'fail' }, { n: 3 }])).toEqual({ action: 'wait' })
    expect(roundOutcome([{ n: 2, outcome: 'fail' }, { n: 3, outcome: 'stalled' }])).toEqual({ action: 'bounce' })
  })

  it('picks the earlier of two passes', () => {
    const a = { n: 2, outcome: 'pass', finishedAt: '2026-11-05T10:20:00Z' }
    const b = { n: 3, outcome: 'pass', finishedAt: '2026-11-05T10:10:00Z' }
    expect(roundOutcome([a, b])).toMatchObject({ winner: b, losers: [a] })
  })
})

describe('verify decision', () => {
  const ev = [{ criterion: 'c', cmd: 'true', logPath: 'l', result: 'exit 0' }]
  const v = (verdict, over = {}) => ({ id: 'x', attempt: 1, verdict, headSha: sha('a'), evidence: ev, findings: [], ...over })

  it('passes, fails, retries cannot_verify once, then asks a human', () => {
    expect(verifyDecision({ tests: v('pass'), spec: v('pass') }, sha('a'), { tests: 1, spec: 1 }).action).toBe('pass')
    const fail = v('fail', { findings: [{ file: 'a', line: 1, claim: 'c', reproCmd: 'false' }] })
    expect(verifyDecision({ tests: v('pass'), spec: fail }, sha('a'), {}).action).toBe('fail')
    expect(verifyDecision({ tests: v('pass'), spec: v('pass', { evidence: [] }) }, sha('a'), { spec: 1 })).toMatchObject({ action: 'retry', kinds: ['spec'] })
    expect(verifyDecision({ tests: v('pass'), spec: v('cannot_verify') }, sha('a'), { spec: 2 }).action).toBe('needs_human')
    expect(verifyDecision({ tests: v('pass') }, sha('b'), {}).action).toBe('reverify')
  })
})

describe('integration culprit loop', () => {
  const merged = [
    { id: 'a', mergeSha: sha('1'), scenarios: ['palette'], criteria: [] },
    { id: 'b', mergeSha: sha('2'), scenarios: [], criteria: [] },
  ]

  it('reverts only a named culprit and stops at the cap', () => {
    expect(nextRevert(['palette'], merged, 0, 2).id).toBe('a')
    expect(nextRevert(['palette'], merged, 2, 2)).toBeNull()
    expect(nextRevert(['palette'], [], 0, 2)).toBeNull()
  })

  it('never reverts on an infrastructure failure without a culprit', () => {
    for (const failed of [['install'], ['verify'], ['ci']]) expect(nextRevert(failed, merged, 0, 2)).toBeNull()
  })

  it('always includes boot in the scenarios', () => {
    expect(integrationScenarios(merged)).toEqual(['boot', 'palette'])
  })
})

describe('design locations', () => {
  it('targets the root designs folder and falls back to the worktree copy', () => {
    const { target, candidates } = designLocations('/repo/', '/repo/tmp/orch/worktrees/x-design-codex', 'x', 'codex')
    expect(target).toBe('/repo/orchestration/designs/x-codex.md')
    expect(candidates).toEqual([target, '/repo/tmp/orch/worktrees/x-design-codex/orchestration/designs/x-codex.md'])
    expect(findDesign(candidates, (p) => p === candidates[1])).toBe(candidates[1])
    expect(findDesign(candidates, () => true)).toBe(target)
    expect(findDesign(candidates, () => false)).toBeNull()
  })
})

describe('design pick and release helpers', () => {
  it('waits for the deadline, then takes the earliest design', () => {
    const designs = [{ lineage: 'codex', mtimeMs: 2 }, { lineage: 'claude', mtimeMs: 3 }]
    expect(pickDesign(designs, false)).toBeNull()
    expect(pickDesign(designs, true)).toBe('codex')
    expect(pickDesign([], true)).toBeNull()
  })

  it('bumps versions and suggests the bump kind', () => {
    expect(bumpVersion('0.8.123', 'patch')).toBe('0.8.124')
    expect(bumpVersion('0.8.123', 'minor')).toBe('0.9.0')
    expect(() => bumpVersion('x', 'patch')).toThrow()
    expect(suggestBump([{ title: 'fix the palette' }])).toBe('patch')
    expect(suggestBump([{ title: 'add a palette filter' }])).toBe('minor')
    expect(setVersion('{\n  "name": "a",\n  "version": "0.8.123",\n  "x": { "version": "1" }\n}', '0.8.124'))
      .toBe('{\n  "name": "a",\n  "version": "0.8.124",\n  "x": { "version": "1" }\n}')
  })
})

describe('worktree setup and release gate', () => {
  it('links existing node_modules into a worktree and skips missing ones', () => {
    const base = mkdtempSync(join(tmpdir(), 'orch-link-'))
    try {
      mkdirSync(join(base, 'root/node_modules'), { recursive: true })
      mkdirSync(join(base, 'root/packages/core/node_modules'), { recursive: true })
      mkdirSync(join(base, 'wt'))
      linkNodeModules(join(base, 'root'), join(base, 'wt'))
      linkNodeModules(join(base, 'root'), join(base, 'wt'))
      expect(lstatSync(join(base, 'wt/node_modules')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(base, 'wt/packages/core/node_modules')).isSymbolicLink()).toBe(true)
      expect(existsSync(join(base, 'wt/apps/desktop/node_modules'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses to release without a passed integration', async () => {
    await expect(release({ opts: {}, roles: {} }, { items: [], integration: { state: 'failed' } }, 'patch')).rejects.toThrow(/passed integration/)
    await expect(release({ opts: {}, roles: {} }, { items: [] }, 'patch')).rejects.toThrow(/not run/)
  })
})

describe('integration rerun', () => {
  const ledgerSchema = JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/ledger.schema.json', import.meta.url)), 'utf8'))

  it('resets to pending and keeps earlier runs in history, still schema-valid', () => {
    const ledger = { batch: 'b', items: [], integration: { state: 'failed', startedAt: 's', failedScenarios: ['verify'] } }
    resetIntegration(ledger)
    expect(ledger.integration).toEqual({ state: 'pending', history: [{ state: 'failed', startedAt: 's', failedScenarios: ['verify'] }] })
    ledger.integration.state = 'passed'
    resetIntegration(ledger)
    expect(ledger.integration.history.map((h) => h.state)).toEqual(['failed', 'passed'])
    expect(validate(ledgerSchema, ledger)).toEqual([])
    const fresh = { batch: 'b', items: [] }
    expect(resetIntegration(fresh)).toEqual({ state: 'pending' })
  })

  it('treats a failed integration as finished and an idle batch as ready', () => {
    const items = [{ state: 'merged' }, { state: 'needs_human' }]
    expect(batchIdle({ items })).toBe(true)
    expect(batchIdle({ items: [...items, { state: 'verifying' }] })).toBe(false)
    expect(batchIdle({ items: [] })).toBe(false)
    expect(integrationFinished({ integration: { state: 'failed' } })).toBe(true)
    expect(integrationFinished({ integration: { state: 'pending' } })).toBe(false)
  })

  it('reports attempt minutes and runs checks on a quiet host', () => {
    expect(attemptMinutes({ startedAt: '2026-11-05T10:00:00Z', finishedAt: '2026-11-05T10:12:30Z' })).toBe(12.5)
    expect(attemptMinutes({ startedAt: '2026-11-05T10:00:00Z' })).toBe('')
    expect(QUIET_HOST).toEqual({ ENGRAM_QUIET_HOST: '1' })
  })
})
