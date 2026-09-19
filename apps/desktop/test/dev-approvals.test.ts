import { expect, it } from 'vitest'
import { DevApprovals } from '../src/main/dev-approvals.js'
import type { DevApproval } from '../src/shared/developers.js'

it('denies outstanding approvals on cancellation and rejects late responses', async () => {
  let shown: DevApproval[] = []
  const gate = new DevApprovals(value => { shown = value }), abort = new AbortController()
  const pending = gate.ask({ kind: 'permission', title: 'Run command', detail: 'command' }, abort.signal)
  const id = shown[0]!.id
  abort.abort()
  expect(await pending).toEqual({ decision: 'deny' })
  expect(shown).toEqual([])
  expect(() => gate.respond(id, { decision: 'allow' })).toThrow('no longer')
  gate.close()
  expect(await gate.ask({ kind: 'permission', title: 'Late', detail: '' }, new AbortController().signal)).toEqual({ decision: 'deny' })
})

it('validates questions without losing the pending request and supports free text', async () => {
  let shown: DevApproval[] = []
  const gate = new DevApprovals(value => { shown = value })
  const pending = gate.ask({ kind: 'question', title: 'Choose', detail: '', questions: [{ id: 'q', text: 'Which?', options: ['One', 'Two'] }] }, new AbortController().signal)
  const id = shown[0]!.id
  expect(() => gate.respond(id, { decision: 'allow', answers: {} })).toThrow()
  expect(() => gate.respond(id, { decision: 'allow', remember: true, answers: { q: ['One'] } })).toThrow()
  expect(shown).toHaveLength(1)
  gate.respond(id, { decision: 'allow', answers: { q: ['A different answer'] } })
  expect(await pending).toMatchObject({ answers: { q: ['A different answer'] } })
})

it('reuses only explicit remembered edit rules and never applies them to unrelated permissions', async () => {
  let shown: DevApproval[] = [], saved: string | undefined
  const gate = new DevApprovals(value => { shown = value }, {
    find: key => key.input === saved ? { decision: 'allow' } : undefined,
    save: key => { saved = key.input },
  })
  const input = { kind: 'permission' as const, title: 'Edit', detail: '', remember: true, rule: { tool: 'Edit', input: 'exact-fingerprint' } }
  const first = gate.ask(input, new AbortController().signal)
  gate.respond(shown[0]!.id, { decision: 'allow', remember: true })
  await first
  expect(await gate.ask(input, new AbortController().signal)).toEqual({ decision: 'allow' })
  const command = gate.ask({ kind: 'permission', title: 'Command', detail: '' }, new AbortController().signal)
  expect(shown).toHaveLength(1)
  gate.close()
  expect(await command).toEqual({ decision: 'deny' })
})
