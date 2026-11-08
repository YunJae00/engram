import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkVerdict } from './aggregate.mjs'
import { evidenceRound, MAX_REQUESTS, runRequests, sandboxOnlyCannotVerify, shareEvidence } from './evidence.mjs'
import { verifierPrompt } from './prompt.mjs'

const sha = 'a'.repeat(40)
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../schemas/verdict.schema.json', import.meta.url)), 'utf8'))
const verdict = (over = {}) => ({ id: 'x', attempt: 1, kind: 'spec', verdict: 'pass', headSha: sha, evidence: [{ criterion: 'c1', cmd: 'diff', logPath: '', result: 'pass: met' }], findings: [], ...over })
const job = { worktree: '/w' }
const sandbox = (result) => verdict({ verdict: 'cannot_verify', evidence: [{ criterion: 'c1', cmd: 'node scripts/verify-cli.mjs s', logPath: '', result }] })
const brief = {
  id: 'x', title: 't', area: 'ts', difficulty: 'easy', goal: 'g', facts: [], allowedFiles: ['a.ts'], outOfScope: [],
  criteria: [{ id: 'c1', cmd: 'node scripts/verify-cli.mjs s', expect: 'exit 0' }], scenarios: ['s'],
}

describe('verdict evidence requests', () => {
  it('keeps verdicts without the field valid and accepts well-formed requests', () => {
    expect(checkVerdict(verdict(), schema).valid).toBe(true)
    expect(checkVerdict(verdict({ verdict: 'cannot_verify', evidenceRequests: [{ cmd: 'ls', why: 'see' }] }), schema).valid).toBe(true)
    expect(checkVerdict(verdict({ evidenceRequests: [{ cmd: 'ls' }] }), schema).valid).toBe(false)
  })

  it('turns requests into one capped runner round for spec and break only', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ cmd: `echo ${i}`, why: 'w' }))
    expect(evidenceRound(verdict({ evidenceRequests: many }), 'spec', job)).toHaveLength(MAX_REQUESTS)
    expect(evidenceRound(verdict({ evidenceRequests: [{ cmd: ' ', why: '' }] }), 'break', job)).toBeNull()
    expect(evidenceRound(verdict({ evidenceRequests: many }), 'tests', job)).toBeNull()
    expect(evidenceRound(verdict({ evidenceRequests: many }), 'spec', { ...job, evidenceRound: true })).toBeNull()
    expect(evidenceRound(verdict({ evidenceRequests: many }), 'spec', { worktree: null })).toBeNull()
    expect(evidenceRound(verdict(), 'spec', job)).toBeNull()
  })

  it('never accepts a cannot_verify that only blames the sandbox launching the app', () => {
    for (const reason of ['kill EPERM', 'Electron exited with SIGABRT', 'electron failed to launch']) {
      expect(sandboxOnlyCannotVerify(sandbox(reason))).toBe(true)
      expect(evidenceRound(sandbox(reason), 'break', job)).toEqual([])
    }
    expect(evidenceRound(sandbox('kill EPERM'), 'spec', { ...job, evidenceRound: true })).toBeNull()
    expect(sandboxOnlyCannotVerify(sandbox('criterion c1 is not covered by the diff'))).toBe(false)
    expect(sandboxOnlyCannotVerify({ ...sandbox('EPERM'), findings: [{ file: 'a', line: 1, claim: 'c', reproCmd: 'r' }] })).toBe(false)
    expect(sandboxOnlyCannotVerify({ ...sandbox('EPERM'), verdict: 'fail' })).toBe(false)
  })
})

describe('runner evidence for spec and break', () => {
  it('runs requested commands in the worktree with a timeout and caps the output it hands back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-req-'))
    try {
      const calls = []
      const run = async (cwd, cmd, args, opts) => {
        calls.push({ cwd, args, opts })
        return { code: 3, out: `${'line\n'.repeat(500)}saved tmp/shot.png` }
      }
      const [r] = await runRequests(dir, 'x-1-spec', [{ cmd: 'node probe.mjs', why: 'see runtime' }], run)
      expect(calls[0]).toMatchObject({ cwd: dir, args: ['-c', 'node probe.mjs'] })
      expect(calls[0].opts.timeoutMs).toBeGreaterThan(0)
      expect(r).toMatchObject({ cmd: 'node probe.mjs', why: 'see runtime', exit: 3, logPath: 'orchestration/logs/x-1-spec-request1.log', screenshots: ['tmp/shot.png'] })
      expect(r.tail.split('\n').length).toBeLessThanOrEqual(40)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies tests-lane logs and the diff into the reviewer worktree and cites them in the prompt', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orch-share-'))
    try {
      const tests = join(base, 'tests')
      const spec = join(base, 'spec')
      mkdirSync(join(tests, 'orchestration/logs'), { recursive: true })
      writeFileSync(join(tests, 'orchestration/logs/x-1-tests-c1.log'), 'ok')
      const results = [{ id: 'c1', cmd: brief.criteria[0].cmd, exit: 0, logPath: 'orchestration/logs/x-1-tests-c1.log', tail: '"ok": true', screenshots: ['tmp/a.png'] }]
      const evidence = await shareEvidence({ base: 'origin/next' }, spec, 'x-1-spec', { worktree: tests, results }, async () => 'diff --git a b')
      expect(readFileSync(join(spec, results[0].logPath), 'utf8')).toBe('ok')
      expect(readFileSync(join(spec, evidence.diffPath), 'utf8')).toContain('diff --git')
      const missing = await shareEvidence({ base: 'b' }, join(base, 'other'), 'x-1-break', { worktree: join(base, 'gone'), results }, async () => '')
      expect(existsSync(join(base, 'other', results[0].logPath))).toBe(false)
      expect(missing.checks).toBe(results)
      for (const kind of ['spec', 'break']) {
        const p = verifierPrompt({ persona: '', kind, brief, headSha: sha, verdictPath: 'v', schemaText: 's', evidence })
        for (const s of [evidence.diffPath, results[0].logPath, '> "ok": true', 'tmp/a.png', 'Do not launch the app', 'never by itself a reason for `cannot_verify`', 'evidenceRequests']) expect(p).toContain(s)
        expect(p).not.toContain('builds the desktop app')
        const requested = [{ id: 'request1', cmd: 'node probe.mjs', why: 'see runtime', exit: 0, logPath: 'orchestration/logs/r.log', tail: 'probe ok' }]
        const again = verifierPrompt({ persona: '', kind, brief, headSha: sha, verdictPath: 'v', schemaText: 's', evidence, requested })
        for (const s of ['one evidence round', 'node probe.mjs', 'asked: see runtime', '> probe ok']) expect(again).toContain(s)
      }
      expect(verifierPrompt({ persona: '', kind: 'break', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toContain('builds the desktop app')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
