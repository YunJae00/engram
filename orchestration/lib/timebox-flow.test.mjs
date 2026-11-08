import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const remote = vi.hoisted(() => ({ files: new Map(), deleted: [], launches: [], missing: new Set() }))

vi.mock('./git.mjs', async (original) => ({
  ...(await original()),
  fetchBranch: async () => {},
  lsRemote: async (_opts, branch) => ([...remote.files.keys()].some((key) => key.startsWith(`origin/${branch}:`)) ? 'sha' : null),
  fileAtRef: async (_opts, ref, path) => remote.files.get(`${ref}:${path}`) ?? null,
  tipSha: async (_opts, ref) => (remote.missing.has(ref) ? null : 'a'.repeat(40)),
  deleteRemoteBranch: async (_opts, branch) => { remote.deleted.push(branch) },
}))

vi.mock('./runtime.mjs', async (original) => {
  const actual = await original()
  const { deadlineAt } = await import('./loop.mjs')
  return {
    ...actual,
    git: async () => '',
    launchAgent: async (_ctx, { agent, label, prompt, role, minutes }) => {
      const startedAt = new Date().toISOString()
      const sessionId = `session_${remote.launches.length + 1}`
      remote.launches.push({ label, role, minutes, prompt, sessionId })
      return { agent, logPath: `logs/${label}.log`, startedAt, deadlineAt: deadlineAt(startedAt, minutes), sessionId }
    },
  }
})

const { loadRoles } = await import('./ledger.mjs')
const { verifyAttempt, settle } = await import('./phase-verify.mjs')
const { checkImplementation } = await import('./phase-implement.mjs')
const { loadJobs } = await import('./runtime.mjs')

const repo = fileURLToPath(new URL('../..', import.meta.url))
const head = 'a'.repeat(40)
const T0 = new Date('2026-11-06T14:50:00.000Z')
const minutes = (n) => new Date(T0.getTime() + n * 60_000)
const brief = { id: 'x', title: 'fix x', area: 'ts', difficulty: 'easy', goal: 'g', criteria: [{ id: 'c', cmd: 'true', expect: 'exit 0' }], allowedFiles: ['scripts/**'], outOfScope: [] }
const evidence = [{ criterion: 'c', cmd: 'true', logPath: 'l', result: 'exit 0' }]
const verdict = (kind, over = {}) => JSON.stringify({ id: 'x', attempt: 1, kind, verdict: 'pass', headSha: head, evidence, findings: [], ...over })
const push = (branch, kind, body) => remote.files.set(`origin/${branch}:orchestration/verdicts/x-1-${kind}.json`, body)

let root
let ctx

function makeCtx() {
  root = mkdtempSync(join(tmpdir(), 'orch-timebox-'))
  const orch = join(root, 'orchestration')
  for (const dir of ['schemas', 'personas']) cpSync(join(repo, 'orchestration', dir), join(orch, dir), { recursive: true })
  mkdirSync(join(orch, 'briefs'), { recursive: true })
  writeFileSync(join(orch, 'briefs/x.json'), JSON.stringify(brief))
  const roles = { ...loadRoles(repo), branchPrefix: 'orch/' } // pinned: the test must not follow live roles.md
  return {
    root, roles, orch, dryRun: false, log: () => {}, opts: { root, remote: 'origin' }, base: 'origin/next',
    logs: join(orch, 'logs'), worktrees: join(root, 'tmp/w'), sem: { free: () => 4, release: () => {}, acquire: () => {} },
  }
}

const ledgerItem = (attempt) => ({
  id: 'x', title: 'fix x', area: 'ts', difficulty: 'easy', state: 'verifying', bounces: 0, allowedFiles: brief.allowedFiles,
  criteria: brief.criteria, scenarios: [], attempts: [attempt], verdicts: [],
})
const decisions = () => readFileSync(join(root, 'orchestration/decisions.tsv'), 'utf8')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  remote.files.clear()
  remote.deleted.length = 0
  remote.launches.length = 0
  remote.missing.clear()
  ctx = makeCtx()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('verifier timebox in the loop', () => {
  const attempt = () => ({
    n: 1, implementer: 'claude-cloud', verifier: 'claude-cloud', branch: 'orch/x-1', startedAt: T0.toISOString(),
    deadlineAt: minutes(40).toISOString(), headSha: head,
  })

  it('relaunches a silent verifier once on a fresh branch, ignores the old session, then records a timeout', async () => {
    const item = ledgerItem(attempt())
    const ledger = { batch: 'b', items: [item] }
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(remote.launches.map((l) => [l.label, l.minutes])).toEqual([['x-1-tests', 20], ['x-1-spec', 20], ['x-1-break', 20]])

    // spec and tests answer; a verdict for another commit on the break branch is not break's verdict.
    push('orch/verdicts/x-1-tests', 'tests', verdict('tests'))
    push('orch/verdicts/x-1-spec', 'spec', verdict('spec'))
    push('orch/verdicts/x-1-break', 'break', verdict('break', { headSha: 'b'.repeat(40) }))
    vi.setSystemTime(minutes(10))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(item.verdicts.map((v) => v.kind)).toEqual(['tests', 'spec'])
    expect(loadJobs(ctx)['x-1-break'].done).toBeUndefined()

    vi.setSystemTime(minutes(21))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    const relaunched = loadJobs(ctx)['x-1-break']
    expect(relaunched).toMatchObject({ tries: 2, verdictBranch: 'orch/verdicts/x-1-break-r2', sessionId: 'session_4' })
    expect(remote.launches.at(-1).prompt).toContain('orch/verdicts/x-1-break-r2')
    expect(decisions()).toMatch(/break timeout\tattempt 1 try 1 passed its deadline; fresh session as try 2/)

    // The first session finally pushes a pass: it is superseded and never read.
    push('orch/verdicts/x-1-break', 'break', verdict('break'))
    vi.setSystemTime(minutes(30))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(item.verdicts).toHaveLength(2)

    vi.setSystemTime(minutes(42))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(item.verdicts.at(-1)).toMatchObject({ kind: 'break', verdict: 'cannot_verify', path: 'orchestration/verdicts/x-1-break-r2.json' })
    expect(item.attempts[0].outcome).toBe('timeout')
    expect(item.state).toBe('needs_human')
    expect(item.reason).toBe('break verifier timed out 2 times')
    expect(remote.launches).toHaveLength(4)
  })

  it('verifies the recorded commit when the branch is gone', async () => {
    remote.missing.add('origin/orch/x-1')
    const item = ledgerItem(attempt())
    await verifyAttempt(ctx, { batch: 'b', items: [item] }, item, item.attempts[0])
    expect(item.attempts[0].headSha).toBe(head)
    expect(item.attempts[0].outcome).toBeUndefined()
    expect(remote.launches.map((l) => l.label)).toEqual(['x-1-tests', 'x-1-spec', 'x-1-break'])
  })

  it('ends the attempt as invalid when neither the branch nor its commit resolves, then bounces the item', async () => {
    const item = ledgerItem(attempt())
    const ledger = { batch: 'b', items: [item] }
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(Object.keys(loadJobs(ctx))).toHaveLength(3)

    remote.missing.add('origin/orch/x-1').add(head)
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(item.attempts[0].outcome).toBe('invalid')
    expect(loadJobs(ctx)).toEqual({})
    expect(decisions()).toMatch(/attempt 1 invalid\tbranch is gone/)
    await settle(ctx, ledger, item)
    expect(item.bounces).toBe(1)
  })

  it('takes the relaunched session verdict when it arrives in time', async () => {
    const item = ledgerItem(attempt())
    const ledger = { batch: 'b', items: [item] }
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    for (const kind of ['tests', 'spec']) push(`orch/verdicts/x-1-${kind}`, kind, verdict(kind))
    vi.setSystemTime(minutes(21))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    push('orch/verdicts/x-1-break-r2', 'break', verdict('break'))
    vi.setSystemTime(minutes(35))
    await verifyAttempt(ctx, ledger, item, item.attempts[0])
    expect(item.attempts[0].outcome).toBe('pass')
    await settle(ctx, ledger, item)
    expect(item.state).toBe('verified')
  })
})

describe('implementation timebox in the loop', () => {
  it('relaunches a silent implementer as a new attempt once, then bounces on the second timeout', async () => {
    const first = { n: 1, implementer: 'claude-cloud', verifier: 'claude-cloud', branch: 'orch/x-1', startedAt: T0.toISOString(), deadlineAt: minutes(40).toISOString(), sessionId: 'session_0' }
    const item = { ...ledgerItem(first), state: 'implementing' }
    const ledger = { batch: 'b', items: [item] }

    vi.setSystemTime(minutes(39))
    await checkImplementation(ctx, ledger, item, first)
    expect(first.outcome).toBeUndefined()

    vi.setSystemTime(minutes(41))
    await checkImplementation(ctx, ledger, item, first)
    expect(first.outcome).toBe('timeout')
    expect(remote.deleted).toContain('orch/x-1')
    const second = item.attempts[1]
    expect(second).toMatchObject({ n: 2, branch: 'orch/x-2', launch: 2, relaunchOf: 1, sessionId: 'session_1' })
    expect(second.deadlineAt).toBe(minutes(81).toISOString())
    expect(remote.launches[0].prompt).toContain('You have 40 minutes from launch.')
    await settle(ctx, ledger, item)
    expect(item.state).toBe('implementing')

    vi.setSystemTime(minutes(82))
    await checkImplementation(ctx, ledger, item, second)
    expect(second.outcome).toBe('timeout')
    expect(item.attempts).toHaveLength(2)
    await settle(ctx, ledger, item)
    expect(item.bounces).toBe(1)
    expect(decisions()).toMatch(/attempt 2 timeout\tno report 40 min after launch 2; no relaunch left/)
  })
})
