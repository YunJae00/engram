import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const host = vi.hoisted(() => ({ launches: [], refuse: new Set() }))

vi.mock('./git.mjs', async (original) => ({ ...(await original()), fetchBranch: async () => {} }))

vi.mock('./runtime.mjs', async (original) => {
  const actual = await original()
  const { deadlineAt } = await import('./loop.mjs')
  return {
    ...actual,
    git: async () => '',
    launchAgent: async (_ctx, { agent, label, cwd, minutes, addDirs = [] }) => {
      host.launches.push({ label, cwd, minutes, addDirs })
      if (host.refuse.has(label)) return null
      const startedAt = new Date().toISOString()
      return { agent, logPath: `/logs/${label}.log`, startedAt, deadlineAt: deadlineAt(startedAt, minutes), pid: 4_000_000 + host.launches.length }
    },
  }
})

const { batchSiblings, batchSize, closeMember, pickBatches, releaseMember } = await import('./batch.mjs')
const { loadRoles } = await import('./ledger.mjs')
const { finish, startBriefed } = await import('./phase-implement.mjs')
const { runChecks } = await import('./phase-verify.mjs')
const { loadJobs } = await import('./runtime.mjs')

const repo = fileURLToPath(new URL('../..', import.meta.url))
const step = { implementer: 'claude-local', verifier: 'codex-local' }
const entry = (id, over = {}, plan = [step]) => ({
  item: { id, area: 'ts', bounces: 0, attempts: [], allowedFiles: [`scripts/${id}/**`], ...over }, hard: false, plan,
})
const ids = (list) => list.map((q) => q.item.id)

describe('batchSize', () => {
  it('is off by default and reads --batch [N] or ORCH_BATCH, capped at 4', () => {
    expect(batchSize(['--quick'], {})).toBe(0)
    expect(batchSize(['--batch'], {})).toBe(3)
    expect(batchSize(['--quick', '--batch', '2'], {})).toBe(2)
    expect(batchSize(['--batch', '--quick'], {})).toBe(3)
    expect(batchSize([], { ORCH_BATCH: '9' })).toBe(4)
    expect(batchSize([], { ORCH_BATCH: '1' })).toBe(0)
    expect(batchSize([], { ORCH_BATCH: 'x' })).toBe(0)
  })
})

describe('pickBatches', () => {
  it('groups easy first attempts of one area up to the size cap', () => {
    const { groups, singles } = pickBatches(['a', 'b', 'c', 'd', 'e'].map((id) => entry(id)), 2)
    expect(groups.map(ids)).toEqual([['a', 'b'], ['c', 'd']])
    expect(ids(singles)).toEqual(['e'])
  })

  it('keeps overlapping allowedFiles apart', () => {
    const { groups, singles } = pickBatches([entry('a', { allowedFiles: ['scripts/**'] }), entry('b', { allowedFiles: ['scripts/b.mjs'] }), entry('c')], 3)
    expect(groups.map(ids)).toEqual([['b', 'c']])
    expect(ids(singles)).toEqual(['a'])
  })

  it('pairs disjoint items and leaves the overlapping one single', () => {
    const { groups, singles } = pickBatches([entry('a', { allowedFiles: ['packages/core/**'] }), entry('b', { allowedFiles: ['packages/core/x.ts'] }), entry('c')], 3)
    expect(groups.map(ids)).toEqual([['a', 'c']])
    expect(ids(singles)).toEqual(['b'])
  })

  it('never batches across areas', () => {
    const { groups } = pickBatches([entry('a'), entry('b', { area: 'native' })], 3)
    expect(groups).toEqual([])
  })

  it('keeps hard, bounced, retried, two-step and cloud items single', () => {
    const queue = [
      entry('a'), { ...entry('h'), hard: true }, entry('r', { bounces: 1 }), entry('t', { attempts: [{ n: 1 }] }),
      entry('p', {}, [step, step]), entry('k', {}, [{ ...step, implementer: 'claude-cloud' }]), entry('z'),
    ]
    const { groups, singles } = pickBatches(queue, 4)
    expect(groups.map(ids)).toEqual([['a', 'z']])
    expect(ids(singles)).toEqual(['h', 'r', 't', 'p', 'k'])
  })

  it('does nothing when batching is off', () => {
    const queue = [entry('a'), entry('b')]
    expect(pickBatches(queue, 0)).toEqual({ groups: [], singles: queue })
  })
})

describe('batch bookkeeping', () => {
  it('closes members one by one and reports the last one', () => {
    const job = { open: ['orch/a-1', 'orch/b-1'] }
    expect(closeMember(job, 'orch/a-1')).toBe(false)
    expect(closeMember(job, 'orch/a-1')).toBe(false)
    expect(closeMember(job, 'orch/b-1')).toBe(true)
    expect(closeMember(undefined, 'orch/x-1')).toBe(true)
  })

  it('finds live implemented siblings by the shared session log', () => {
    const shared = { logPath: '/logs/batch-a-x3.log' }
    const ledger = { items: [
      { attempts: [{ ...shared, branch: 'orch/a-1', headSha: 'a' }] },
      { attempts: [{ ...shared, branch: 'orch/b-1', headSha: 'b', outcome: 'fail' }] },
      { attempts: [{ ...shared, branch: 'orch/c-1' }] },
      { attempts: [{ logPath: '/logs/d-1.log', branch: 'orch/d-1', headSha: 'd' }] },
    ] }
    expect(batchSiblings(ledger, ledger.items[0].attempts[0]).map((a) => a.branch)).toEqual(['orch/a-1'])
    expect(batchSiblings(ledger, ledger.items[3].attempts[0])).toEqual([])
  })
})

describe('batched implement flow', () => {
  let root
  let ctx
  let released
  const briefOf = (id) => ({ id, title: `fix ${id}`, area: 'ts', difficulty: 'easy', goal: 'g', facts: [], criteria: [{ id: 'c', cmd: 'true', expect: 'exit 0' }], allowedFiles: [`scripts/${id}/**`], outOfScope: [] })
  const ledgerItem = (id) => {
    const { title, area, difficulty, criteria, allowedFiles } = briefOf(id)
    return { id, title, area, difficulty, criteria, allowedFiles, state: 'briefed', bounces: 0, scenarios: [], attempts: [], verdicts: [] }
  }

  beforeEach(() => {
    host.launches.length = 0
    host.refuse.clear()
    released = []
    root = mkdtempSync(join(tmpdir(), 'orch-batch-'))
    const orch = join(root, 'orchestration')
    for (const dir of ['schemas', 'personas']) cpSync(join(repo, 'orchestration', dir), join(orch, dir), { recursive: true })
    mkdirSync(join(orch, 'briefs'), { recursive: true })
    for (const id of ['a', 'b', 'c']) writeFileSync(join(orch, `briefs/${id}.json`), JSON.stringify(briefOf(id)))
    ctx = {
      root, orch, roles: { ...loadRoles(repo), branchPrefix: 'orch/' }, dryRun: false, log: () => {}, batch: 3,
      opts: { root, remote: 'origin' }, base: 'origin/next', logs: join(orch, 'logs'), worktrees: join(root, 'tmp/w'),
      sem: { free: () => 3, release: (pid) => released.push(pid), acquire: () => {} },
    }
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('launches one session for the group and keeps per-item attempts in the ledger schema', async () => {
    const ledger = { batch: 'b', items: ['a', 'b', 'c'].map(ledgerItem) }
    await startBriefed(ctx, ledger)
    expect(host.launches.map((l) => l.label)).toEqual(['batch-a-x3'])
    expect(host.launches[0].addDirs).toEqual(['a', 'b', 'c'].map((id) => join(ctx.worktrees, `${id}-1`)))
    expect(host.launches[0].minutes).toBe(80)
    expect(ledger.items.map((i) => [i.state, i.attempts.map((a) => [a.n, a.branch, a.logPath])])).toEqual(
      ['a', 'b', 'c'].map((id) => ['implementing', [[1, `orch/${id}-1`, '/logs/batch-a-x3.log']]]),
    )
    expect(loadJobs(ctx)['batch-a-x3'].open).toEqual(['orch/a-1', 'orch/b-1', 'orch/c-1'])
    expect(readFileSync(join(root, 'orchestration/ledger.json'), 'utf8')).toContain('batch-a-x3')

    // The shared session lives until the last member has an outcome.
    const [a, b, c] = ledger.items.map((i) => i.attempts[0])
    await finish(ctx, a, 'pass')
    await finish(ctx, b, 'fail')
    expect(released).toEqual([])
    await finish(ctx, c, 'invalid')
    expect(released).toEqual([c.pid])
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['pass', 'fail', 'invalid'])
  })

  it('splits the group into single sessions when the batch launch fails', async () => {
    host.refuse.add('batch-a-x3')
    const ledger = { batch: 'b', items: ['a', 'b', 'c'].map(ledgerItem) }
    await startBriefed(ctx, ledger)
    expect(host.launches.map((l) => l.label)).toEqual(['batch-a-x3', 'a-1', 'b-1', 'c-1'])
    expect(ledger.items.map((i) => [i.state, i.attempts.length, i.attempts[0].logPath])).toEqual(
      ['a', 'b', 'c'].map((id) => ['implementing', 1, `/logs/${id}-1.log`]),
    )
    expect(readFileSync(join(root, 'orchestration/decisions.tsv'), 'utf8')).toMatch(/batch batch-a-x3 split/)
  })

  it('a bounced member runs alone on its next attempt', async () => {
    const ledger = { batch: 'b', items: [{ ...ledgerItem('a'), bounces: 1, attempts: [{ n: 1, implementer: 'claude-local', verifier: 'codex-local', branch: 'orch/a-1', startedAt: 't', deadlineAt: 't', logPath: '/logs/batch-a-x2.log', outcome: 'fail' }] }, ledgerItem('b')] }
    writeFileSync(join(ctx.orch, 'briefs/a.json'), JSON.stringify({ ...briefOf('a'), design: 'orchestration/designs/a-claude.md' }))
    await startBriefed(ctx, ledger)
    const labels = host.launches.map((l) => l.label)
    expect(labels).toContain('a-2')
    expect(labels).toContain('b-1')
    expect(labels.some((l) => l.startsWith('batch-'))).toBe(false)
  })
})

describe('shared check in the tests lane', () => {
  it('skips the per-item check:quick and cites the shared log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-shared-'))
    try {
      writeFileSync(join(dir, 'shared.log'), 'tsc ok\n')
      const calls = []
      const run = async (_cwd, _cmd, args) => { calls.push(args[1]); return { code: 0, out: '' } }
      const brief = { criteria: [{ id: 'c', cmd: 'true', expect: 'exit 0' }] }
      const shared = { exit: 0, shas: ['a', 'b'], logPath: join(dir, 'shared.log'), tail: 'tsc ok' }
      const results = await runChecks({ base: 'origin/next' }, dir, brief, 'a-1-tests', run, shared)
      expect(calls).toEqual(['true'])
      expect(results.map((r) => [r.id, r.exit])).toEqual([['check:quick', 0], ['c', 0]])
      expect(results[0].tail).toContain('shared batch check over 2 items')
      expect(existsSync(join(dir, results[0].logPath))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a member outside any batch never touches jobs', () => {
    const ctx = { logs: '/nonexistent', dryRun: true }
    expect(releaseMember(ctx, { logPath: '/logs/a-1.log', branch: 'orch/a-1' })).toBe(true)
  })
})
