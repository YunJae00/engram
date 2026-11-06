import { describe, expect, it } from 'vitest'
import { smokeState } from './release.mjs'

const job = (name, status, conclusion = null) => ({ name, status, conclusion })

describe('release smoke result', () => {
  it('reads only the smoke job of the Release run', () => {
    const jobs = [job('build (macos-26-intel, macos)', 'completed', 'failure'), job('smoke / desktop smoke (macOS)', 'completed', 'success')]
    expect(smokeState(jobs)).toEqual({ state: 'passed', jobs: ['smoke / desktop smoke (macOS): success'] })
  })

  it('waits while the smoke job runs and fails on any other conclusion', () => {
    expect(smokeState([job('smoke / desktop smoke (macOS)', 'in_progress')]).state).toBe('pending')
    expect(smokeState([job('smoke / desktop smoke (macOS)', 'completed', 'failure')]).state).toBe('failed')
    expect(smokeState([job('smoke / desktop smoke (macOS)', 'completed', 'cancelled')]).state).toBe('failed')
  })

  it('reports a run without a smoke job as missing', () => {
    expect(smokeState([job('publish', 'completed', 'success')]).state).toBe('missing')
    expect(smokeState(undefined).state).toBe('missing')
  })
})
