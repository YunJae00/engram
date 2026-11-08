import { describe, expect, it } from 'vitest'
import { designerPrompt, implementerPrompt, verifierLinuxDesktop, verifierPrompt, REPORT_SCHEMA_TEXT } from './prompt.mjs'

const brief = {
  id: 'fix-thing',
  title: 'fix the thing',
  area: 'ts',
  difficulty: 'easy',
  goal: 'make the thing work',
  facts: ['thing breaks on empty input'],
  criteria: [{ id: 'c1', cmd: 'npx vitest run thing', expect: 'exit 0' }],
  allowedFiles: ['packages/core/src/thing.ts'],
  outOfScope: ['apps/desktop/**'],
  scenarios: ['thing-scenario'],
}
const rules = 'RULE: no Co-Authored-By trailers'
const sha = 'a'.repeat(40)

describe('implementerPrompt', () => {
  const args = { persona: '# Implementer persona', rules, brief, branch: 'orch/fix-thing-1', baseBranch: 'next', reportPath: 'orchestration/reports/fix-thing.json' }

  it('includes persona, rules, brief, branch and report contract', () => {
    const p = implementerPrompt({ ...args, cloud: true })
    for (const s of ['# Implementer persona', rules, 'npx vitest run thing', 'exit 0', 'packages/core/src/thing.ts', 'apps/desktop/**',
      'git checkout -b orch/fix-thing-1', 'pnpm install --frozen-lockfile', 'npm run check:quick',
      'git add -f orchestration/reports/fix-thing.json', 'git push -u origin orch/fix-thing-1', REPORT_SCHEMA_TEXT]) {
      expect(p).toContain(s)
    }
  })

  it('skips install and branch creation for a local worktree', () => {
    const p = implementerPrompt({ ...args, cloud: false })
    expect(p).not.toContain('pnpm install')
    expect(p).not.toContain('git checkout -b')
    expect(p).toContain('git push -u origin orch/fix-thing-1')
  })

  it('carries the findings of earlier attempts, and no section without any', () => {
    const findings = [{ where: 'a.ts:3', claim: 'drops the limit reason', reproCmd: 'npx vitest run a' }]
    const p = implementerPrompt({ ...args, findings })
    for (const s of ['## Previous findings', 'a.ts:3: drops the limit reason', 'repro: `npx vitest run a`']) expect(p).toContain(s)
    expect(implementerPrompt(args)).not.toContain('## Previous findings')
  })
})

describe('verifierPrompt', () => {
  it.each(['tests', 'spec', 'break', 'desktop'])('%s prompt carries schema, headSha and verdict path', (kind) => {
    const p = verifierPrompt({ persona: '# V', kind, brief, headSha: sha, verdictPath: `orchestration/verdicts/fix-thing-1-${kind}.json`, schemaText: '{"VERDICT_SCHEMA":1}' })
    expect(p).toContain('{"VERDICT_SCHEMA":1}')
    expect(p).toContain(sha)
    expect(p).toContain(`orchestration/verdicts/fix-thing-1-${kind}.json`)
    expect(p).toContain('JSON only')
  })

  it('tests kind lists every criterion command and spec kind diffs against base', () => {
    expect(verifierPrompt({ persona: '', kind: 'tests', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toContain('npx vitest run thing')
    expect(verifierPrompt({ persona: '', kind: 'spec', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toContain('git diff next...HEAD')
  })

  it('spec and break prompts treat the report commit as required, implementer adds tests only in allowed files', () => {
    for (const kind of ['spec', 'break']) {
      expect(verifierPrompt({ persona: '', kind, brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toContain(`orchestration/reports/${brief.id}.json\` is the implementer's required report commit`)
    }
    expect(implementerPrompt({ persona: '', rules, brief, branch: 'b', baseBranch: 'next', reportPath: 'r' })).toContain('Add tests only inside the allowed files; if no test file is allowed, do not create one.')
    expect(verifierPrompt({ persona: '', kind: 'desktop', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toContain('node scripts/verify-cli.mjs thing-scenario')
  })

  it('tells scenario checks to build a missing desktop entry once and not pass --build', () => {
    const scenarioBrief = {
      ...brief,
      criteria: [{ id: 'ui', cmd: 'node scripts/verify-cli.mjs thing-scenario', expect: 'exit 0 and JSON ok true' }],
    }
    for (const kind of ['tests', 'desktop']) {
      const p = verifierPrompt({ persona: '', kind, brief: scenarioBrief, headSha: sha, verdictPath: 'v', schemaText: 's' })
      expect(p).toContain('apps/desktop/out/main/index.js')
      expect(p).toContain('Do not append `--build`')
      expect(p).not.toContain('verify-cli.mjs thing-scenario --build')
    }
    const plain = verifierPrompt({ persona: '', kind: 'tests', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })
    expect(plain).not.toContain('out/main/index.js')
    expect(implementerPrompt({ persona: '', rules, brief: scenarioBrief, branch: 'b', baseBranch: 'next', reportPath: 'r' })).toContain('Do not append `--build`')
    expect(implementerPrompt({ persona: '', rules, brief, branch: 'b', baseBranch: 'next', reportPath: 'r' })).not.toContain('out/main/index.js')
  })

  it('desktop prompt refuses a brief that names no scenario', () => {
    const p = verifierPrompt({ persona: '', kind: 'desktop', brief: { ...brief, scenarios: [] }, headSha: sha, verdictPath: 'v', schemaText: 's' })
    expect(p).toContain('cannot_verify')
    expect(p).not.toContain('thing-scenario')
    expect(p).toContain('"ok": true')
  })

  it('cloud prompts use Xvfb and return verdicts on their own branch', () => {
    for (const cloud of [false, true]) {
      const p = implementerPrompt({ persona: '', rules, brief: { ...brief, criteria: [{ id: 'ui', cmd: 'node scripts/verify-cli.mjs thing-scenario', expect: 'exit 0' }] }, branch: 'b', baseBranch: 'next', reportPath: 'r', cloud })
      if (cloud) expect(p).toContain('xvfb-run -a')
      else expect(p).not.toContain('xvfb-run')
      const v = verifierPrompt({ persona: '', kind: 'desktop', brief, headSha: sha, verdictPath: 'v', schemaText: 's', cloud, verdictBranch: 'orch/verdicts/test' })
      if (cloud) for (const value of ['xvfb-run -a', 'orch/verdicts/test', 'Do not modify the implementation branch']) expect(v).toContain(value)
      else expect(v).not.toContain('xvfb-run')
    }
  })

  it('tells a local Linux verifier to run desktop scenarios under xvfb-run', () => {
    expect(verifierLinuxDesktop(false, 'linux')).toBe(true)
    expect(verifierLinuxDesktop(true, 'linux')).toBe(false)
    expect(verifierLinuxDesktop(false, 'darwin')).toBe(false)
    for (const kind of ['tests', 'spec', 'break', 'desktop']) {
      const p = verifierPrompt({ persona: '', kind, brief, headSha: sha, verdictPath: 'v', schemaText: 's', linux: true })
      expect(p).toContain('xvfb-run -a')
      expect(p).toContain('Write the verdict JSON at the path in the steps.')
      expect(p).not.toContain('Do not modify the implementation branch')
      const timed = verifierPrompt({ persona: '', kind, brief, headSha: sha, verdictPath: 'v', schemaText: 's', linux: true, minutes: 20 })
      expect(timed).toContain('write a `cannot_verify` verdict')
      expect(timed).not.toContain('write and push')
    }
    const testsCli = verifierPrompt({
      persona: '', kind: 'tests', headSha: sha, verdictPath: 'v', schemaText: 's', linux: true,
      brief: { ...brief, scenarios: [], criteria: [{ id: 'ui', cmd: 'node scripts/verify-cli.mjs thing-scenario', expect: 'exit 0' }] },
    })
    expect(testsCli).toContain('xvfb-run -a')
    expect(testsCli).toContain('node scripts/verify-cli.mjs thing-scenario')
    const specOnly = verifierPrompt({
      persona: '', kind: 'spec', headSha: sha, verdictPath: 'v', schemaText: 's', linux: true,
      brief: { ...brief, scenarios: [], criteria: [{ id: 'c1', cmd: 'npx vitest run thing', expect: 'exit 0' }] },
    })
    expect(specOnly).not.toContain('xvfb-run')
    expect(verifierPrompt({ persona: '', kind: 'desktop', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).not.toContain('xvfb-run')
  })

  it('rejects an unknown kind', () => {
    expect(() => verifierPrompt({ persona: '', kind: 'nope', brief, headSha: sha, verdictPath: 'v', schemaText: 's' })).toThrow()
  })
})

describe('designerPrompt', () => {
  it('includes rules, brief and design path', () => {
    const p = designerPrompt({ persona: '# D', rules, brief, designPath: 'orchestration/designs/fix-thing-claude.md' })
    expect(p).toContain(rules)
    expect(p).toContain('make the thing work')
    expect(p).toContain('orchestration/designs/fix-thing-claude.md')
    expect(p).not.toContain('## Rejected design')
  })

  it('carries earlier findings and the rejected design when designing again', () => {
    const findings = [{ where: 'criterion c1', claim: 'exit 1', reproCmd: 'npx vitest run thing' }]
    const p = designerPrompt({ persona: '# D', rules, brief, designPath: 'd.md', findings, rejectedDesign: 'branch on the pending flag\n' })
    for (const s of ['## Previous findings', 'criterion c1: exit 1', '## Rejected design', 'branch on the pending flag']) expect(p).toContain(s)
  })
})

describe('runner-executed tests verifier', () => {
  it('hands captured results to the reviewer instead of telling it to run commands', async () => {
    const { runChecks } = await import('./phase-verify.mjs')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'orch-checks-'))
    try {
      const calls = []
      const run = async (cwd, cmd, args, opts) => { calls.push({ cwd, args, opts }); return { code: args[1].includes('fail') ? 1 : 0, out: '' } }
      const results = await runChecks({ base: 'origin/next' }, dir, brief, 'x-1-tests', run)
      expect(calls[0].args[1]).toBe('npm run check:quick')
      expect(calls[0].opts).toMatchObject({ env: { ENGRAM_CHECK_BASE: 'origin/next' }, unset: ['ENGRAM_HIDDEN'] })
      expect(calls[1].opts.unset).toEqual(['ENGRAM_HIDDEN'])
      expect(results.map((r) => [r.id, r.exit])).toEqual([['check:quick', 0], ...brief.criteria.map((c) => [c.id, c.cmd.includes('fail') ? 1 : 0])])
      const p = verifierPrompt({ persona: '', kind: 'tests', brief, headSha: sha, verdictPath: 'v', schemaText: 's', results })
      expect(p).toContain('do not rerun them')
      expect(p).toContain(`exit 0 expect:`)
      expect(p).toContain(results[0].logPath)
      expect(p).not.toContain('Run every criterion command')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
