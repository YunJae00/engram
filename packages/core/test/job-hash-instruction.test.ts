import { describe, expect, it } from 'vitest'
import { buildJ8, J8_INSTRUCTION } from '../src/jobs/librarian.js'
import { jobHash } from '../src/jobs/runner.js'
import type { VaultPaths } from '../src/vault.js'

describe('the journal key follows the instruction, not just the data', () => {
  it('re-runs a job whose template changed under identical inputs', () => {
    const base = { kind: 'J8' as const, inputKey: '2026-07-27:abc123' }
    const before = jobHash({ ...base, instruction: 'old wording' })
    const after = jobHash({ ...base, instruction: 'new wording' })
    expect(after).not.toBe(before)
  })

  it('still skips a job that changed in neither', () => {
    const job = { kind: 'J8' as const, inputKey: '2026-07-27:abc123', instruction: 'same' }
    expect(jobHash(job)).toBe(jobHash({ ...job }))
  })

  it('keeps different inputs apart under one template', () => {
    const instruction = 'same'
    expect(jobHash({ kind: 'J8', inputKey: 'a', instruction })).not.toBe(
      jobHash({ kind: 'J8', inputKey: 'b', instruction }),
    )
  })

  // The field is only useful if the builders actually carry the live constant —
  // a spec that stamped a placeholder would hash stably and reintroduce the bug.
  it('stamps the brief job with the instruction it is about to send', () => {
    const paths = { views: '/v', notes: '/n', inbox: '/i', cache: '/c' } as unknown as VaultPaths
    const spec = buildJ8(paths, '# AGENTS', { loops: [] }, new Date('2026-07-27T00:00:00Z'))
    expect(spec.instruction).toBe(J8_INSTRUCTION)
    expect(spec.prompt).toContain(J8_INSTRUCTION)
  })
})
