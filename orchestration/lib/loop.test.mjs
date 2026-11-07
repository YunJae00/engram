import { describe, expect, it } from 'vitest'
import { fileURLToPath, URL } from 'node:url'
import { loadRoles } from './ledger.mjs'
import {
  briefScenarios, bumpVersion, deadlineAt, designLocations, designPath, findDesign, globToRegExp, integrationScenarios, machineCheck, needsRedesign,
  nextRevert, pickDesign, plannedAttempts, rejectedDesignPath, roundOutcome, suggestBump, verifyDecision, verifierKindsFor,
} from './loop.mjs'
import { rejectDesign } from './phase-implement.mjs'
import { release, setVersion } from './release.mjs'
import { linkNodeModules, previousFindings } from './runtime.mjs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { attemptMinutes, batchIdle, integrationFinished, QUIET_HOST, resetIntegration, scenarioCommand } from './phase-merge.mjs'
import { validate } from './validate.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roles = loadRoles(fileURLToPath(new URL('../..', import.meta.url)))
const sha = (c) => c.repeat(40)
const item = (over = {}) => ({ id: 'x', area: 'ts', bounces: 0, ...over })

describe('bounce ladder', () => {
  it('takes one rung per bounce for easy items', () => {
    expect(plannedAttempts(item(), roles, false)).toEqual([{ implementer: 'claude-cloud', verifier: 'codex-local' }])
    expect(plannedAttempts(item({ bounces: 2 }), roles, false)).toEqual([{ implementer: 'claude-cloud', verifier: 'codex-local' }])
    expect(plannedAttempts(item({ bounces: 3 }), roles, false)).toEqual([])
  })

  it('runs independent claude attempts at once for hard items after the first FAIL', () => {
    expect(plannedAttempts(item(), roles, true)).toHaveLength(1)
    expect(plannedAttempts(item({ bounces: 1 }), roles, true)).toEqual([
      { implementer: 'claude-cloud', verifier: 'codex-local' },
      { implementer: 'claude-cloud', verifier: 'codex-local' },
    ])
    expect(plannedAttempts(item({ area: 'native', bounces: 2 }), roles, true)).toEqual([
      { implementer: 'claude-cloud', verifier: 'codex-local' },
      { implementer: 'claude-cloud', verifier: 'codex-local' },
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

describe('deadlines', () => {
  it('adds the role minutes to the launch time', () => {
    expect(deadlineAt('2026-11-05T10:00:00.000Z', 45)).toBe('2026-11-05T10:45:00.000Z')
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

  it('loads scenarios from the integration worktree using the local CLI', () => {
    expect(scenarioCommand('palette', false)).toEqual(['scripts/verify-cli.mjs', 'palette', '--build'])
    expect(scenarioCommand('ui-activity-status', true)).toEqual(['scripts/verify-cli.mjs', 'ui-activity-status'])
  })

  it('never reverts on an infrastructure failure without a culprit', () => {
    for (const failed of [['install'], ['verify'], ['ci']]) expect(nextRevert(failed, merged, 0, 2)).toBeNull()
  })

  it('always includes boot in the scenarios', () => {
    expect(integrationScenarios(merged)).toEqual(['boot', 'palette'])
  })

  it('reads a verify-cli criterion when scenarios is empty', () => {
    const item = { scenarios: [], criteria: [{ id: 'ui', cmd: 'node scripts/verify-cli.mjs note-open --build', expect: 'ok true' }] }
    expect(briefScenarios(item)).toEqual(['note-open'])
    expect(integrationScenarios([item])).toEqual(['boot', 'note-open'])
  })
})

describe('desktop verifier selection', () => {
  const roles = { verifierKinds: ['tests', 'spec', 'break'] }

  it('keeps tests, spec and break when the brief names no scenario', () => {
    expect(verifierKindsFor(roles, { scenarios: [], criteria: [{ cmd: 'npm test', expect: '0' }] })).toEqual(['tests', 'spec', 'break'])
  })

  it('adds desktop once when a scenario is listed or commanded', () => {
    expect(verifierKindsFor(roles, { scenarios: ['palette'], criteria: [] })).toEqual(['tests', 'spec', 'break', 'desktop'])
    expect(verifierKindsFor(
      { verifierKinds: ['tests', 'spec', 'break', 'desktop'] },
      { scenarios: ['palette'], criteria: [] },
    )).toEqual(['tests', 'spec', 'break', 'desktop'])
    expect(verifierKindsFor(roles, { criteria: [{ cmd: 'node scripts/verify-cli.mjs inbox', expect: 'ok true' }] })).toEqual(['tests', 'spec', 'break', 'desktop'])
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

describe('retry after a FAIL', () => {
  const fixture = (run) => {
    const root = mkdtempSync(join(tmpdir(), 'orch-retry-'))
    const ctx = { root, orch: join(root, 'orchestration') }
    try {
      for (const dir of ['briefs', 'designs', 'verdicts']) mkdirSync(join(ctx.orch, dir), { recursive: true })
      run(ctx, (rel, value) => writeFileSync(join(root, rel), typeof value === 'string' ? value : JSON.stringify(value)))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('redesigns only on a second bounce of an item that has a design', () => {
    expect(needsRedesign(1, true)).toBe(false)
    expect(needsRedesign(2, true)).toBe(true)
    expect(needsRedesign(2, false)).toBe(false)
  })

  it('sets the chosen design aside and clears it from the brief', () => {
    fixture((ctx, write) => {
      const brief = join(ctx.orch, 'briefs/x.json')
      write('orchestration/briefs/x.json', { id: 'x', design: designPath('x', 'claude') })
      write(designPath('x', 'claude'), 'chosen design')
      write(designPath('x', 'codex'), 'other design')
      expect(rejectDesign(ctx, { id: 'x', bounces: 1 })).toBe(false)
      expect(JSON.parse(readFileSync(brief, 'utf8')).design).toBe(designPath('x', 'claude'))
      expect(rejectDesign(ctx, { id: 'x', bounces: 2 })).toBe(true)
      expect(JSON.parse(readFileSync(brief, 'utf8'))).toEqual({ id: 'x' })
      expect(readFileSync(join(ctx.root, rejectedDesignPath('x')), 'utf8')).toBe('chosen design')
      expect(existsSync(join(ctx.root, designPath('x', 'claude')))).toBe(false)
      expect(existsSync(join(ctx.root, designPath('x', 'codex')))).toBe(false)
      expect(rejectDesign(ctx, { id: 'x', bounces: 3 })).toBe(false)
    })
  })

  it('reads the findings of every failed verdict the ledger points at', () => {
    fixture((ctx, write) => {
      const finding = { file: 'a.ts', line: 3, claim: 'drops the limit reason', reproCmd: 'npx vitest run a' }
      write('orchestration/verdicts/x-1-break.json', { id: 'x', verdict: 'fail', evidence: [], findings: [finding] })
      write('orchestration/verdicts/x-1-spec.json', { id: 'x', verdict: 'pass', evidence: [], findings: [] })
      const verdicts = ['break', 'spec', 'tests'].map((kind) => ({ path: `orchestration/verdicts/x-1-${kind}.json` }))
      expect(previousFindings(ctx, { verdicts })).toEqual([{ where: 'a.ts:3', claim: 'drops the limit reason', reproCmd: 'npx vitest run a' }])
    })
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
