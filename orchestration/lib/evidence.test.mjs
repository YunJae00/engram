import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkVerdict } from './aggregate.mjs'
import { DESKTOP_BUILD, evidenceRound, hiddenUnset, MAX_REQUESTS, rootVitest, runCommands, runRequests, sandboxOnlyCannotVerify, shareEvidence, testsGate, withoutBuild } from './evidence.mjs'
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

describe('package-filtered vitest commands', () => {
  it('rewrites them to the root unit project with repo-relative paths', () => {
    expect(rootVitest('pnpm --filter desktop exec vitest run test/markdown.test.ts && pnpm --filter @engram/core exec vitest run test/prose.test.ts'))
      .toBe('pnpm exec vitest run --project unit apps/desktop/test/markdown.test.ts && pnpm exec vitest run --project unit packages/core/test/prose.test.ts')
    expect(rootVitest('pnpm -F core exec vitest run ./test/a.test.ts -t name')).toBe('pnpm exec vitest run --project unit packages/core/test/a.test.ts -t name')
    expect(rootVitest('pnpm --filter=desktop exec vitest run')).toBe('pnpm exec vitest run --project unit apps/desktop')
  })

  it('leaves other commands as written', () => {
    for (const cmd of [
      'pnpm exec vitest run --project unit apps/desktop/test/markdown.test.ts',
      'pnpm --filter desktop exec vitest run --project unit test/a.test.ts',
      'pnpm --filter unknown exec vitest run test/a.test.ts',
      'pnpm --filter desktop build && cd apps/desktop && npx playwright test e2e/x.spec.ts --reporter=line',
    ]) expect(rootVitest(cmd)).toBe(cmd)
  })

  it('runs and reports the rewritten command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-vitest-'))
    try {
      const calls = []
      const run = async (cwd, cmd, args) => { calls.push(args[1]); return { code: 0, out: '' } }
      const [r] = await runCommands(dir, 'x', [{ id: 'unit-3', cmd: 'pnpm --filter desktop exec vitest run test/markdown.test.ts' }], 1000, run)
      expect(calls).toEqual(['pnpm exec vitest run --project unit apps/desktop/test/markdown.test.ts'])
      expect(r.cmd).toBe(calls[0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('strips ENGRAM_HIDDEN from unit commands and keeps it for e2e even when the runner has it set', async () => {
    const { sh } = await import('./runtime.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'orch-hidden-'))
    vi.stubEnv('ENGRAM_HIDDEN', '1')
    try {
      expect(hiddenUnset('pnpm exec vitest run --project unit apps/desktop')).toEqual(['ENGRAM_HIDDEN'])
      for (const cmd of ['npm run check:quick', 'npm run typecheck', 'npm run lint']) expect(hiddenUnset(cmd)).toEqual(['ENGRAM_HIDDEN'])
      for (const cmd of ['pnpm exec playwright test e2e/x.spec.ts', 'node scripts/verify-cli.mjs s', 'npm run verify', 'pnpm --filter desktop test:e2e', 'electron .']) expect(hiddenUnset(cmd)).toEqual([])
      const probe = 'echo "hidden=${ENGRAM_HIDDEN-absent}"'
      const unit = await runRequests(dir, 'u', [{ cmd: `${probe} # vitest` }], sh)
      const e2e = await runRequests(dir, 'e', [{ cmd: `${probe} # playwright` }], sh)
      expect(unit[0].tail).toBe('hidden=absent')
      expect(e2e[0].tail).toBe('hidden=1')
    } finally {
      vi.unstubAllEnvs()
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

describe('runner-run commands', () => {
  it('builds the desktop app once, then runs criteria without the build step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-build-'))
    try {
      const calls = []
      const run = async (cwd, cmd, args, opts) => { calls.push({ cmd: args[1], unset: opts.unset }); return { code: 0, out: '' } }
      const commands = [
        { id: 'unit', cmd: 'npx vitest run a.test.ts' },
        { id: 'c1', cmd: `${DESKTOP_BUILD} && node scripts/verify-cli.mjs boot`, expect: '0' },
        { id: 'c2', cmd: `${DESKTOP_BUILD} && node scripts/verify-cli.mjs note-open`, expect: '0' },
        { id: 'c3', cmd: DESKTOP_BUILD, expect: '0' },
      ]
      const results = await runCommands(dir, 'x-1-tests', commands, 1000, run)
      expect(calls.map((c) => c.cmd)).toEqual(['npx vitest run a.test.ts', DESKTOP_BUILD, 'node scripts/verify-cli.mjs boot', 'node scripts/verify-cli.mjs note-open'])
      expect(calls[0].unset).toEqual(['ENGRAM_HIDDEN'])
      expect(calls[2].unset).toEqual([])
      expect(results.map((r) => [r.id, r.cmd, r.exit])).toEqual(commands.map((c) => [c.id, c.cmd, 0]))
      expect(results[3].logPath).toBe('orchestration/logs/x-1-tests-desktop_build.log')
      expect(withoutBuild('npm test')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails every criterion needing a failed build with the build log, without running it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-build-'))
    try {
      const calls = []
      const run = async (cwd, cmd, args) => { calls.push(args[1]); return { code: args[1] === DESKTOP_BUILD ? 2 : 0, out: 'vite: error' } }
      const commands = ['boot', 'note-open'].map((s) => ({ id: s, cmd: `${DESKTOP_BUILD} && node scripts/verify-cli.mjs ${s}` }))
      const results = await runCommands(dir, 'x-1-tests', commands, 1000, run)
      expect(calls).toEqual([DESKTOP_BUILD])
      for (const r of results) expect(r).toMatchObject({ exit: 2, logPath: 'orchestration/logs/x-1-tests-desktop_build.log', tail: 'vite: error' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tests lane gate for spec and break', () => {
  const kinds = ['tests', 'spec', 'break']
  it('waits for the runner tests lane, launches on pass and fails on any failed command', () => {
    expect(testsGate(kinds, undefined)).toBe('wait')
    expect(testsGate(kinds, { results: [{ exit: 0 }, { exit: 0 }] })).toBe('go')
    expect(testsGate(kinds, { results: [{ exit: 0 }, { exit: 1 }] })).toBe('fail')
    expect(testsGate(kinds, { sessionId: 's' })).toBe('go')
    expect(testsGate(kinds, { verdictBranch: 'verdict/x' })).toBe('go')
    // A local lane whose runner commands are still running has no results yet.
    expect(testsGate(kinds, { pid: 1, worktree: '/w', headSha: sha })).toBe('wait')
    expect(testsGate(['spec', 'break'], undefined)).toBe('go')
  })
})
