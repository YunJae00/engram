import { describe, expect, it } from 'vitest'
import { deferredCriteria, implementerPrompt, isFullSuite, scopedCriteria, verifierPrompt } from './prompt.mjs'

const brief = {
  id: 'x', title: 'x', area: 'ts', difficulty: 'easy', goal: 'g', facts: [], allowedFiles: ['a.ts'], outOfScope: [],
  criteria: [
    { id: 'scenario', cmd: 'node scripts/verify-cli.mjs ui-x', expect: 'ok' },
    { id: 'unit', cmd: 'pnpm vitest run --project unit apps/desktop/test/x.test.ts', expect: 'exit 0' },
    { id: 'typecheck', cmd: 'pnpm run typecheck', expect: 'exit 0' },
    { id: 'test', cmd: 'pnpm run test', expect: 'exit 0' },
    { id: 'verify', cmd: 'npm run verify', expect: 'exit 0' },
  ],
}

describe('per-item test scope', () => {
  it('treats only whole-suite commands as deferred', () => {
    expect(['pnpm run test', 'npm run verify', 'npm test', 'pnpm run test:e2e', 'pnpm run check', 'xvfb-run -a npm run verify'].every(isFullSuite)).toBe(true)
    expect(['pnpm run typecheck', 'pnpm run lint', 'pnpm run css-scan', 'pnpm vitest run --project unit a.test.ts', 'node scripts/verify-cli.mjs ui-x', 'npm run check:quick'].some(isFullSuite)).toBe(false)
    expect(scopedCriteria(brief).map((c) => c.id)).toEqual(['scenario', 'unit', 'typecheck'])
    expect(deferredCriteria(brief).map((c) => c.id)).toEqual(['test', 'verify'])
  })

  it('tells the tests verifier to run scoped checks and defer the full suite', () => {
    const text = verifierPrompt({ persona: 'P', kind: 'tests', brief, headSha: 'a'.repeat(40), verdictPath: 'v.json', schemaText: '{}', attempt: 1, baseBranch: 'next', cloud: false, linux: true })
    expect(text).toContain('ENGRAM_CHECK_BASE=next npm run check:quick')
    expect(text).toContain('node scripts/verify-cli.mjs ui-x')
    expect(text).toContain('deferred to integration')
    expect(text).not.toMatch(/- test: `pnpm run test`/)
    expect(text).not.toMatch(/- verify: `npm run verify`/)
  })

  it('tells a local Linux implementer to skip whole-suite criteria and use Xvfb', () => {
    const text = implementerPrompt({ persona: 'P', rules: 'R', brief, branch: 'orch/x-1', baseBranch: 'next', reportPath: 'orchestration/reports/x.json', cloud: false, linux: true })
    expect(text).toContain('except whole-suite ones (`pnpm run test`, `npm run verify`)')
    expect(text).toContain('xvfb-run -a')
  })
})
