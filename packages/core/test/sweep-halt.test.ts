import { beforeEach, describe, expect, it } from 'vitest'
import type { Engine, EngineEvent } from '../src/engine/types.js'
import { loadAbsorbState, saveAbsorbState } from '../src/import.js'
import { createNote } from '../src/notes.js'
import { loadState, sweep } from '../src/jobs/sweep.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

function engineOf(events: () => EngineEvent[]): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() {
      yield* events()
    },
  }
}

const deadLogin = (): EngineEvent[] => [{ type: 'error', message: 'Invalid API key · Please run /login' }]
const overLimit = (): EngineEvent[] => [{ type: 'error', message: '429 rate limit' }]

let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('sweep-halt'), { git: false })
  await createNote(paths, { id: 'n-alpha-0001', body: '# Alpha\n\nA thought worth filing.' })
  await createNote(paths, { id: 'n-beta-0001', body: '# Beta\n\nAnother thought.' })
})

// Stamping last_sweep CONSUMES the delta — the next sweep diffs against it. A
// run that could not do its work must therefore not stamp, or the notes that
// were in flight fall out of every future delta permanently. This is the one
// failure that outlives its own cause, which is why it reads as "it just
// stopped working" long after the token was fixed.
describe('a sweep that could not work does not consume the delta', () => {
  it('leaves last_sweep unset when the login is dead, and reports the reason', async () => {
    const report = await sweep(paths, [engineOf(deadLogin)])
    expect(report.haltReason).toBe('auth')
    expect(report.executed).toBe(0)
    expect((await loadState(paths)).last_sweep).toBeUndefined()
  })

  it('leaves last_sweep unset on a usage limit too', async () => {
    const report = await sweep(paths, [engineOf(overLimit)])
    expect(report.haltReason).toBe('quota')
    expect((await loadState(paths)).last_sweep).toBeUndefined()
  })

  it('stamps last_sweep on a run that actually did the work', async () => {
    const report = await sweep(paths, [engineOf(() => [{ type: 'result', text: '{"links":[]}' }])])
    expect(report.haltReason).toBeUndefined()
    expect((await loadState(paths)).last_sweep).toBeTruthy()
  })
})

// takeAbsorbBatch removes the batch from `pending` and persists immediately.
// Only a quota deferral used to put it back, so an auth/network/timeout
// failure dropped its 20 notes on the floor — the drain loop then ate the
// whole import queue at full speed while every job failed.
describe('the absorb batch survives a failed sweep', () => {
  it('puts the batch back when the engine is logged out', async () => {
    await saveAbsorbState(paths, { pending: ['n-alpha-0001', 'n-beta-0001'], total: 2 })
    await sweep(paths, [engineOf(deadLogin)])
    expect((await loadAbsorbState(paths)).pending).toEqual(['n-alpha-0001', 'n-beta-0001'])
  })

  it('puts the batch back when every job simply failed', async () => {
    await saveAbsorbState(paths, { pending: ['n-alpha-0001'], total: 1 })
    await sweep(paths, [engineOf(() => [{ type: 'error', message: 'engine crashed' }])])
    expect((await loadAbsorbState(paths)).pending).toEqual(['n-alpha-0001'])
  })
})
