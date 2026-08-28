import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ruleFor } from 'core'
import { approvalsStore } from '../src/main/approvals.js'

// Standing approvals live in one small file; a rule leaves with its routine.
describe('approvalsStore', () => {
  it('keeps a rule across reads, forgets one, and retires a routine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-approvals-'))
    const store = approvalsStore(dir)
    const a = ruleFor({ routineId: 'rt-1', kind: 'submit', host: 'a.example.com', fieldLabels: ['Entry'] })
    const b = ruleFor({ routineId: 'rt-2', kind: 'submit', host: 'b.example.com', fieldLabels: ['Entry'] })
    await store.add(a)
    await store.add(b)
    await store.add(a)
    expect((await store.list()).map((r) => r.routineId)).toEqual(['rt-1', 'rt-2'])
    expect(await approvalsStore(dir).list()).toHaveLength(2)
    await store.forget(a.fingerprint)
    expect((await store.list()).map((r) => r.routineId)).toEqual(['rt-2'])
    await store.retire('rt-2')
    expect(await store.list()).toEqual([])
  })

  it('reads nothing from a missing or broken file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-approvals-'))
    expect(await approvalsStore(dir).list()).toEqual([])
  })
})
