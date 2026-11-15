import { describe, expect, it } from 'vitest'
import { CLAUDE_RUNTIME_VERSION, OPUS_55, workModelFor } from '../src/main/claude-runtime-version.js'

// QA 0.8.142 B1: a fresh install sent claude-opus-5-5 to the bundled Claude Code
// 2.1.272, which answers every such call with "400 ... does not support this model;
// version 2.1.280 or newer". The work model must be one the bundled runtime accepts.
describe('work model follows the bundled Claude runtime', () => {
  it('never names Opus 5.5 to a runtime older than Claude Code 2.1.280', () => {
    expect(workModelFor('0.3.272')).toBe('opus')
    expect(workModelFor('0.3.279')).toBe('opus')
    expect(workModelFor('0.2.999')).toBe('opus')
    expect(workModelFor('garbage')).toBe('opus')
  })
  it('uses Opus 5.5 once the runtime accepts it', () => {
    expect(workModelFor('0.3.280')).toBe(OPUS_55)
    expect(workModelFor('0.3.325')).toBe(OPUS_55)
    expect(workModelFor('0.4.0')).toBe(OPUS_55)
    expect(workModelFor('1.0.0')).toBe(OPUS_55)
  })
  it('gives the shipped runtime a model it accepts', () => {
    const patch = Number(CLAUDE_RUNTIME_VERSION.split('.')[2])
    expect(workModelFor(CLAUDE_RUNTIME_VERSION)).toBe(patch >= 280 ? OPUS_55 : 'opus')
  })
})
