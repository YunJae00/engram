import { expect, it, vi } from 'vitest'
import type { AgentLoopResult, TurnStep } from 'core'
import { checkResult, resultCheckTool } from '../src/main/result-check.js'
import { canLearnTurn, changedResult, commandOnlyReads, freshResultReadback, needsResultCheck, nothingToReadBack } from '../src/main/task-result-state.js'
import { done, pressed, readback, setup } from './task-runner-fixture.js'

const read: TurnStep = { tool: 'read_open_page', args: {}, observation: 'Current saved state' }

it('posts a finished answer before its re-check starts, and keeps only the hidden re-check turn off the thread', async () => {
  const draft = '견적 세 건을 표로 비교했어요. [견적 비교](engram-artifact:quotes.xlsx)'
  const seen: string[][] = []
  const t = await setup(async (_request, turn) => {
    seen.push([...t.delivered])
    return turn === 1 ? { ...done(draft, 1), check: { accepted: false, issues: ['Quote total not read back'] } } : { ...done(draft, 1), check: { accepted: true, issues: [] }, trail: [read] }
  })
  await t.chat('견적서 세 개 비교해서 표로 만들어줘')
  expect(t.sent).toHaveLength(2)
  expect(t.sent[1]?.extra?.verification).toMatchObject({ result: draft })
  expect(seen).toEqual([[], [draft]])
  expect(t.delivered).toEqual([draft])
})
const result = (steps: TurnStep[], extra: Partial<AgentLoopResult> = {}) => ({ steps, ...extra })
const report = async (): Promise<TurnStep> => {
  const finding = { status: 'pass', basis: 'The requested state is present.' }
  const args = { checks: [{ ...finding, requirement: 'Finish the task' }], grounding: finding }
  return { tool: 'report_result_check', args, observation: await resultCheckTool().run(args, { task: 'Finish the task' }) }
}

it('does not learn a held draft before its verification turn', () => {
  expect(canLearnTurn(result([read]), true)).toBe(false)
  expect(canLearnTurn(result([]), false)).toBe(true)
})

it('does not learn a passing report that has no fresh readback', async () => {
  const steps = [await report()]
  const check = checkResult(steps, [], [])
  expect(check.accepted).toBe(true)
  expect(freshResultReadback(steps)).toBe(false)
  expect(canLearnTurn(result(steps), true, check)).toBe(false)
  expect(canLearnTurn(result(steps), false, check)).toBe(false)
})

it.each(['scroll', 'open_page', 'press'])('does not learn a report after a failed %s invalidates its earlier evidence', async tool => {
  const steps = [read, { tool, args: {}, observation: 'that did not work: unavailable' }, await report()]
  const check = checkResult(steps, [], [])
  expect(check.accepted).toBe(true)
  expect(freshResultReadback(steps)).toBe(false)
  expect(canLearnTurn(result(steps), true, check)).toBe(false)
  expect(canLearnTurn(result(steps), false, check)).toBe(false)
})

it('defers even an accepted held check to task completion, and validates non-held checks', async () => {
  const steps = [read, await report()]
  expect(canLearnTurn(result(steps), true, checkResult(steps, [], []))).toBe(false)
  expect(canLearnTurn(result(steps), false, checkResult(steps, [], []))).toBe(true)
  expect(canLearnTurn(result(steps), false, { accepted: false })).toBe(false)
  expect(canLearnTurn(result([{ ...read, seeded: true }]), false, { accepted: true })).toBe(false)
})

it('records verified evidence from the original turn without an extra check', async () => {
  const t = await setup(async () => ({ ...done('Confirmed final result', 3), trail: [pressed('Save'), ...readback('').trail!], check: { accepted: true, issues: [] } }))
  await t.chat('Save the requested fields')
  expect((await t.settle('done')).verified).toBe(true)
  expect(t.sent).toHaveLength(1)
  await vi.waitFor(() => expect(t.remembered).toHaveLength(1))
  expect(t.remembered[0]).toContain('Confirmed final result')
})

it.each<Partial<AgentLoopResult>>([{ asked: true }, { stopped: 'calls' }, { pending: 'run_procedure' }, { incomplete: 'More work remains' }])('does not learn an unfinished turn %j', extra => {
  expect(canLearnTurn(result([read], extra), false)).toBe(false)
  expect(canLearnTurn(result([read], extra), true, { accepted: true })).toBe(false)
})

it('checks a result only when something was saved, committed or changed, not after reading a site', () => {
  const look = [{ tool: 'open_page', args: { url: 'https://tms.example' }, observation: 'opened' }, pressed('Time Report', false), { tool: 'choose', args: { target: 'Project', option: 'ChatX' }, observation: 'chosen' }, read]
  expect(needsResultCheck('Last week: 58 hours.', look)).toBe(false)
  expect(needsResultCheck('Last week: 58 hours.', [...look, pressed('Save')])).toBe(true)
  expect(needsResultCheck('Last week: 58 hours.', [...look, { tool: 'page_steps', args: {}, observation: 'Done in order: press "Save".', committed: true }])).toBe(true)
  expect(needsResultCheck('Partially saved', [{ tool: 'page_steps', args: {}, observation: 'that did not work: Save succeeded, Next failed', committed: true }])).toBe(true)
  expect(needsResultCheck('Last week: 58 hours.', [...look, { tool: 'page_steps', args: {}, observation: 'Done in order: press "Next".' }])).toBe(false)
  expect(needsResultCheck('Saved [Report](engram-artifact:report.md)', look)).toBe(true)
  expect(needsResultCheck('Done', [{ tool: 'excel_write', args: {}, observation: 'written' }])).toBe(true)
  expect(needsResultCheck('Done', [{ ...pressed('Save'), observation: 'that did not work: no such control' }])).toBe(false)
})

it.each([
  ['diff .check/a .check/b', true], ['cat notes.md | wc -l', true], ['cd leads && ls -la; grep -c 규정 a.md', true],
  ['cat > report.md <<EOF\nx\nEOF', false], ['echo done >> report.md', false], ['python3 build.py', false], ['sed -i s/a/b/ report.md', false],
  ['rg -n 규정 leads', true], ['rg -i pre-release notes.md', true], ['grep -z x a.md', true],
  ['rg --pre /bin/sh x .', false], ["rg '--pre=/bin/sh' x .", false], ['rg --pre-glob *.md --pre ./p x', false], ['cat a.md | rg --pre ./p x', false],
  ['rg --hostname-bin ./h x', false], ['rg --search-zip x .', false], ['rg -iz x .', false],
  ['cat a.md | tee report.md', false], ['cp a.md report.md', false], ['echo $(rm report.md)', false], ['ls; mv a.md b.md', false], ['FOO=1 ls', false], [undefined, false],
])('reads command %j as only reading: %s', (command, reads) => {
  expect(commandOnlyReads(command)).toBe(reads)
  for (const tool of ['Bash', 'PowerShell', 'Shell']) expect(nothingToReadBack('Five rules.', [{ tool, args: { command }, observation: 'Native action completed.' }])).toBe(reads)
  const fileRead: TurnStep = { tool: 'file_read', args: { path: 'report.md' }, observation: '{"content":"x","completeReadback":true}' }
  const finding = { status: 'pass', basis: 'Read.' }
  const report: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ ...finding, requirement: 'Report' }], grounding: finding } }) }
  for (const tool of ['Bash', 'PowerShell', 'Shell']) {
    const ran: TurnStep = { tool, args: { command }, observation: 'Native action completed.' }
    expect(freshResultReadback([fileRead, ran])).toBe(reads)
    expect(freshResultReadback([fileRead, ran, fileRead])).toBe(true)
    expect(freshResultReadback([{ ...ran, seeded: true }, fileRead])).toBe(true)
    expect(canLearnTurn({ steps: [fileRead, ran] }, false, { accepted: true, verified: true, issues: [] })).toBe(reads)
    expect(checkResult([fileRead, report, ran], [], [], true).issues.includes('The result changed after report_result_check. Reread the affected result and submit a new report.')).toBe(!reads)
    expect(checkResult([fileRead, ran, report], [], [], true).issues.join(' ')).not.toContain('The result changed after report_result_check')
  }
})
it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('a native %s after the check or the last read stales them', (tool) => {
  const fileRead: TurnStep = { tool: 'file_read', args: { path: 'report.md' }, observation: '{"content":"x","completeReadback":true}' }
  const finding = { status: 'pass', basis: 'Read.' }
  const report: TurnStep = { tool: 'report_result_check', args: {}, observation: JSON.stringify({ resultCheck: { checks: [{ ...finding, requirement: 'Report' }], grounding: finding } }) }
  const changed = 'The result changed after report_result_check. Reread the affected result and submit a new report.'
  for (const observation of ['Native action completed.', 'that did not work: exit 1']) {
    const wrote: TurnStep = { tool, args: { file_path: 'report.md' }, observation }
    expect(checkResult([fileRead, report, wrote], [], [], true).issues).toContain(changed)
    expect(checkResult([fileRead, wrote, report], [], [], true).issues).not.toContain(changed)
    expect(freshResultReadback([fileRead, report, wrote])).toBe(false)
    expect(freshResultReadback([fileRead, wrote])).toBe(false)
    expect(freshResultReadback([fileRead, wrote, fileRead])).toBe(true)
    expect(freshResultReadback([{ ...wrote, seeded: true }, fileRead])).toBe(true)
    expect(canLearnTurn({ steps: [fileRead, report, wrote] }, false, { accepted: true, verified: true, issues: [] })).toBe(false)
    expect(nothingToReadBack('Five rules.', [wrote])).toBe(false)
  }
})
it('has nothing to read back only for words, with no file linked and nothing changed', () => {
  expect(nothingToReadBack('Five rules.', [])).toBe(true)
  expect(nothingToReadBack('[Report](engram-artifact:report.md)', [])).toBe(false)
  expect(nothingToReadBack('Five rules.', [{ tool: 'Bash', args: { command: 'python3 build.py' }, observation: 'that did not work: exit 1' }])).toBe(false)
  expect(nothingToReadBack('Five rules.', [{ tool: 'Bash', args: { command: 'python3 build.py' }, observation: 'Native action completed.', seeded: true }])).toBe(true)
})

it('counts a file move as a change to the result, read back by its own receipt', () => {
  const moved = { tool: 'file_move', args: { moves: [{ from: 'a.pdf', to: 'PDF/a.pdf' }] }, observation: '{"moved":1}' }
  expect(changedResult([moved])).toBe(true)
  expect(needsResultCheck('Done', [moved])).toBe(true)
  expect(nothingToReadBack('Done', [moved])).toBe(false)
  expect(freshResultReadback([moved])).toBe(false)
  expect(freshResultReadback([{ ...moved, observedAfterAction: true }])).toBe(true)
  expect(changedResult([{ ...moved, observation: 'that did not work: Nothing was moved' }])).toBe(false)
})
