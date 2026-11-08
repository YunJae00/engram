import { beforeEach, describe, expect, it, vi } from 'vitest'
import process from 'node:process'

const calls = vi.hoisted(() => ({ sh: [], notes: [] }))

vi.mock('./git.mjs', async (original) => ({
  ...(await original()),
  fetchBranch: async () => {},
  squashMerge: async () => 'b'.repeat(40),
  push: async () => {},
}))

vi.mock('./phase-verify.mjs', () => ({ cleanAttempt: async () => {}, dropBranch: async () => {} }))

vi.mock('./runtime.mjs', async (original) => ({
  ...(await original()),
  git: async () => '',
  note: (_ctx, ...args) => { calls.notes.push(args) },
  save: () => {},
  prepareNext: async () => '/tmp/next',
  syncBaseBranch: async () => {},
  sh: async (_cwd, cmd, args) => {
    calls.sh.push([cmd, ...args])
    return { code: 0, out: '3' }
  },
}))

const { batchIdle, integrate, integrationFinished, mergeVerified } = await import('./phase-merge.mjs')

const ctx = {
  root: '/tmp/root', logs: '/tmp/orch-phase-merge-logs', nextWorktree: '/tmp/next', roles: { baseBranch: 'next', mainBranch: 'main' },
  opts: { remote: 'origin' }, integrationTier: 'quick',
}
const item = (id, state, over = {}) => ({ id, title: `fix ${id}`, state, scenarios: [], attempts: [], verdicts: [], ...over })
const verified = (id) => item(id, 'verified', { attempts: [{ n: 1, outcome: 'pass', implementer: 'local', branch: `orch/${id}-1` }] })
const passedLedger = () => ({
  batch: 1, items: [item('a', 'integrated', { mergeSha: 'a'.repeat(40) }), verified('b')],
  integration: { state: 'passed', startedAt: 't0', finishedAt: 't1', logPath: 'old.log' },
})

beforeEach(() => {
  calls.sh.length = 0
  calls.notes.length = 0
  process.env.ENGRAM_SKIP_CI = '1'
})

describe('integration after a late merge', () => {
  it('reopens a passed integration, reruns it, and integrates the late item', async () => {
    const ledger = passedLedger()
    await mergeVerified(ctx, ledger)
    expect(ledger.items[1].state).toBe('merged')
    expect(ledger.integration.state).toBe('pending')
    expect(integrationFinished(ledger)).toBe(false)
    expect(batchIdle(ledger)).toBe(true)
    await integrate(ctx, ledger)
    expect(ledger.items.map((i) => i.state)).toEqual(['integrated', 'integrated'])
    expect(ledger.integration.state).toBe('passed')
    expect(ledger.integration.history).toEqual([{ state: 'passed', startedAt: 't0', finishedAt: 't1', logPath: 'old.log' }])
    expect(calls.sh.some(([cmd, ...args]) => cmd === 'pnpm' && args.join(' ') === 'run test')).toBe(true)
  })

  it('reopens a failed integration when a new item merges', async () => {
    const ledger = { ...passedLedger(), integration: { state: 'failed', failedScenarios: ['boot'] } }
    await mergeVerified(ctx, ledger)
    expect(ledger.integration).toEqual({ state: 'pending', history: [{ state: 'failed', failedScenarios: ['boot'] }] })
  })

  it('leaves a finished integration alone when nothing new merged', async () => {
    const ledger = passedLedger()
    ledger.items.pop()
    await mergeVerified(ctx, ledger)
    expect(integrationFinished(ledger)).toBe(true)
    await integrate(ctx, ledger)
    expect(ledger.integration).toEqual({ state: 'passed', startedAt: 't0', finishedAt: 't1', logPath: 'old.log' })
    expect(calls.sh).toEqual([])
  })
})
