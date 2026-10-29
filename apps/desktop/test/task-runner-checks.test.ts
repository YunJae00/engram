import { expect, it, vi } from 'vitest'
import { listTasks } from 'core'
import type { TurnOutcome } from '../src/main/task-runner.js'
import { done, setup, pressed, readback } from './task-runner-fixture.js'

it.each(['throws', 'no answer', 'ignores abort'])('delivers the draft once when its check %s', async failure => {
  const t = await setup(async (_request, turn) => {
    if (turn === 1) return done('[Report](engram-artifact:report.md)')
    if (failure === 'throws') throw new Error('Provider disconnected')
    if (failure === 'ignores abort') return new Promise<TurnOutcome>(() => {})
    return undefined as unknown as TurnOutcome
  }, false, 30)
  await t.chat('Write the report')
  expect((await t.settle('done')).verified).not.toBe(true)
  expect(t.delivered).toEqual([expect.stringContaining('[Report](engram-artifact:report.md)')])
  expect(t.delivered[0]).toContain('⚠ Checked')
  expect(t.remembered).toEqual([])
  expect(t.events.some(event => event.type === 'chat:error')).toBe(false)
})

it('never delivers a held result after the person stops its check', async () => {
  let finish!: () => void
  const t = await setup(async (_request, turn) => {
    if (turn === 1) return done('[Report](engram-artifact:report.md)')
    await new Promise<void>(resolve => { finish = resolve })
    return readback('Checked report')
  })
  const sending = t.chat('Write the report')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await t.runner.stopChannel('bot-bot-1')
  finish()
  await sending
  expect((await t.settle('stopped')).verified).not.toBe(true)
  expect(t.delivered).toEqual([])
})

it('continues a deferred approval answered before the turn finishes', async () => {
  const verdicts: string[] = []
  const t = await setup(async (request, turn, _extra, runner) => {
    verdicts.push(await runner.askFor(request.channel!, async () => 'approve', 0)!({ words: 'Send', url: 'https://example.test/draft' }))
    if (turn === 1) {
      const task = (await listTasks(t.paths))[0]!
      await t.call('tasks:decide', task.id, task.approvals[0]!.id, 'approve')
    }
    return done('Ready')
  })
  await t.chat('Send the draft')
  expect((await t.settle('done')).turns).toBe(2)
  expect(verdicts).toEqual(['later', 'approve'])
})

it('consumes a running approval only once across simultaneous calls', async () => {
  const confirm = vi.fn(async () => 'approve' as const)
  const t = await setup(async (request, _turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, confirm, 1200)!
    const calls = [ask({ words: 'Run commands', url: 'file:///work' }), ask({ words: 'Run commands', url: 'file:///work' })]
    await vi.waitFor(async () => expect((await listTasks(t.paths))[0]!.approvals).toHaveLength(1))
    const task = (await listTasks(t.paths))[0]!
    await t.call('tasks:decide', task.id, task.approvals[0]!.id, 'approve')
    const results = await Promise.all(calls)
    expect(results.filter(result => result === 'approve')).toHaveLength(1)
    return done('Ready')
  })
  await t.chat('Calculate totals')
  expect(confirm).toHaveBeenCalledTimes(1)
})

it('keeps the complete command visible and cannot reuse its approval for another command', async () => {
  const words = `Run this command outside the sandbox?\n${'echo safe; '.repeat(30)}Remove-Item report.txt`
  const confirm = vi.fn(async () => 'approve' as const)
  const t = await setup(async (request, _turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, confirm, 1200)!
    const waiting = ask({ words, url: 'file:///work#command-one' })
    await vi.waitFor(async () => expect((await listTasks(t.paths))[0]!.approvals).toHaveLength(1))
    const task = (await listTasks(t.paths))[0]!
    expect(task.approvals[0]!.words).toBe(words)
    await t.call('tasks:decide', task.id, task.approvals[0]!.id, 'approve')
    expect(await waiting).toBe('approve')
    expect(await runner.askFor(request.channel!, confirm, 0)!({ words, url: 'file:///work#command-two' })).toBe('later')
    return done('Ready')
  })
  await t.chat('Prepare a report')
  expect(confirm).toHaveBeenCalledTimes(1)
})

it('does not ask again after a running command approval was declined', async () => {
  const confirm = vi.fn(async () => 'approve' as const)
  const t = await setup(async (request, _turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, confirm, 1200)!
    const waiting = ask({ words: 'Run commands', url: 'file:///work' })
    await vi.waitFor(async () => expect((await listTasks(t.paths))[0]!.approvals).toHaveLength(1))
    const task = (await listTasks(t.paths))[0]!
    await t.call('tasks:decide', task.id, task.approvals[0]!.id, 'decline')
    expect(await waiting).toBe('cancel')
    expect(await ask({ words: 'Run commands', url: 'file:///work' })).toBe('cancel')
    return done('Skipped commands')
  })
  await t.chat('Calculate totals')
  expect((await t.settle('done')).approvals).toHaveLength(1)
  expect(confirm).not.toHaveBeenCalled()
})

it.each([
  { check: undefined, unfinished: false },
  { check: { accepted: false, issues: ['A material claim has no source.'] }, unfinished: false },
  { check: undefined, unfinished: true },
])('never completes on a read alone and bounds failed or interrupted checks (%j)', async ({ check, unfinished }) => {
  const t = await setup(async (_r, turn) => turn === 1
    ? { ...done('Saved', 1), trail: [pressed('Save')] }
    : { ...readback('Everything is correct'), check, unfinished }, false)
  await t.chat('Prepare a sourced summary')
  const task = await t.settle('done')
  expect(task.turns).toBe(2)
  expect(task.verified).not.toBe(true)
  expect(task.result).toContain('⚠ Checked')
  expect(task.result).not.toContain('Everything is correct')
  expect(t.delivered).toHaveLength(1)
  expect(t.remembered).toEqual([])
})

it('answers with the draft when the check overruns its budget', async () => {
  const t: Awaited<ReturnType<typeof setup>> = await setup(async (_r, turn) => {
    if (turn === 1) return { ...done('Saved [Report](engram-artifact:report.md)', 1), trail: [pressed('Save')] }
    // The check hangs until the runner cuts it short; an aborted turn has no outcome.
    await new Promise<void>(resolve => { t.aborted.resolve = resolve })
    return undefined as unknown as TurnOutcome
  }, true, 30)
  await t.chat('Prepare the report')
  const task = await t.settle('done')
  expect(task.turns).toBe(2)
  expect(task.verified).not.toBe(true)
  expect(task.verificationIssue).toBe('The check ran out of time.')
  expect(t.delivered).toEqual([`Saved [Report](engram-artifact:report.md)${'\n\n⚠ Checked; some of this could not be confirmed against the original.'}`])
})

it('does not demand a text read or a repeated recording for media-only evidence', async () => {
  const t = await setup(async () => done('[Capture](engram-artifact:clip.mp4)'))
  await t.chat('Save this browser capture')
  expect((await t.settle('done')).turns).toBe(1)
})

it.each([false, true])('keeps corrected outputs across a repair and recheck (unfinished=%s)', async unfinished => {
  const t = await setup(async (_r, turn) => turn === 1
    ? { ...done('The customer has no existing process', 1), trail: [pressed('Save')] }
    : { ...readback(turn === 2 ? 'Needs a correction [Latest](engram-artifact:latest.txt)' : 'Removed the unsupported claim'), unfinished: turn === 2 && unfinished, check: { accepted: turn === 3, issues: turn === 2 ? ['Source states a goal, not the current situation.'] : [] } })
  await t.chat('Prepare the proposal')
  const task = await t.settle('done')
  expect(task.turns).toBe(2)
  expect(task.result).toContain('engram-artifact:latest.txt')
  expect(task.result).toContain('⚠ Checked')
  expect(task.verificationIssue).toBeDefined()
  expect(t.delivered).toEqual([task.result])
})

it('delivers a checked answer with how it was checked and the record of this comet', async () => {
  const report = { checks: [{ requirement: 'Totals match the CSV', status: 'pass' as const, basis: 'Summed the 400 rows and compared each department.' }], grounding: { status: 'pass' as const, basis: 'Read sales.csv in full.' }, sources: ['sales.csv'] }
  const t = await setup(async (_request, turn) => {
    if (turn === 1) return done('[Report](engram-artifact:report.md)')
    return { ...readback('[Report](engram-artifact:report.md)'), check: { accepted: true, issues: [], report } }
  }, false)
  await t.chat('Total the sales by department')
  expect((await t.settle('done')).verified).toBe(true)
  expect(t.delivered).toHaveLength(1)
  expect(t.evidences).toEqual([{ ...report, record: { confirmed: 1, checked: 1 } }])
})

it('does not display a rejected host check as fully confirmed', async () => {
  const report = { checks: [{ requirement: 'Totals match', status: 'pass' as const, basis: 'Compared totals.' }], grounding: { status: 'pass' as const, basis: 'Read the source.' }, sources: ['sales.csv'] }
  const t = await setup(async (_request, turn) => turn === 1
    ? done('[Report](engram-artifact:report.md)')
    : { ...readback('[Report](engram-artifact:report.md)'), check: { accepted: false, issues: ['The source was not fully read.'], report } }, false)
  await t.chat('Total the sales')
  expect((await t.settle('done')).verified).not.toBe(true)
  expect(t.evidences).toEqual([{ ...report, grounding: { status: 'unknown', basis: 'The source was not fully read.' }, record: { confirmed: 0, checked: 1 } }])
})

it('answers a lookup at once: reading a site, with its tabs and filters, needs no check', async () => {
  const t = await setup(async () => ({ ...done('Last week: 58 hours.', 3), trail: [{ tool: 'open_page', args: { url: 'https://tms.example' }, observation: 'opened' }, pressed('Time Report', false), { ...pressed('Week view', false), observedAfterAction: true }] }))
  await t.chat('How many hours did I log last week?')
  const task = await t.settle('done')
  expect(task.verified).toBeUndefined()
  expect(task.verificationIssue).toBeUndefined()
  expect(task.log.map(line => line.line)).not.toContain('Checking the result')
  expect(t.sent).toHaveLength(1)
  expect(t.delivered).toEqual([])
})
