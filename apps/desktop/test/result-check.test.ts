import { describe, expect, it } from 'vitest'
import type { TurnStep } from 'core'
import { checkResult as verifyResult, latestResultOutputs, resultCheckTool } from '../src/main/result-check.js'

const source = 'C:/fixtures/source.md', path = 'C:/artifacts/proposal.md', hash = 'a'.repeat(64)
const outputs = [{ name: 'proposal.md', path }]
const read = (target = path, extra = {}): TurnStep => ({ tool: 'file_read', args: { path: target },
  observation: JSON.stringify({ path: target, sha256: hash, content: 'Price is an estimate pending confirmation.', offset: 0, nextOffset: null, truncated: false, ...extra }) })
const create = (name = 'proposal.md', target = path): TurnStep => ({ tool: 'file_create_copy', args: { name }, observation: JSON.stringify({ path: target, sha256: hash, completeReadback: true }) })
const finding = (refs?: string[]) => ({ status: 'pass', basis: 'Read the final result against the requested deliverable.', ...(refs ? { refs } : {}) })
const payload = (refs?: string[]) => ({ checks: [{ requirement: 'Complete proposal', ...finding(refs) }],
  grounding: { ...finding(), basis: 'The source supports the facts; unavailable pricing is explicitly an estimate, not a confirmed rate.' } })
const recorded = async (value: unknown = payload()): Promise<TurnStep> => ({ tool: 'report_result_check', args: value as Record<string, unknown>,
  observation: await resultCheckTool().run(value as Record<string, unknown>, { task: 'Prepare a proposal' }) })
const checkResult: typeof verifyResult = (steps, ...options) =>
  verifyResult(steps.some(step => step.tool === 'report_result_check') ? steps : [...steps,
    { tool: 'report_result_check', args: payload(), observation: JSON.stringify({ resultCheck: payload() }) }], ...options)

describe('result check receipt', () => {
  it('limits acceptance checks to requested outcomes and asks for concise factual bases', () => {
    const description = resultCheckTool().description
    expect(description).toContain('Derive acceptance checks only from the original requested outcomes and constraints')
    expect(description).toContain('Do not promote optional inspection methods or extra workflows into new requirements')
    expect(description).toContain('Keep each basis concise: name the observed fact')
    expect(description).toContain('do not retake, upload or claim visual verification')
  })

  it('requires a verdict, but leaves evidence references optional', async () => {
    expect(verifyResult([read()], outputs, [source]).issues.join(' ')).toContain('verdict is missing')
    expect(verifyResult([], [], []).accepted).toBe(false)
    expect(checkResult([read(), await recorded()], outputs, [source])).toEqual({ accepted: true, issues: [] })
    expect(checkResult([read(), await recorded(payload(['step:99', 'whatever']))], outputs, [source]).accepted).toBe(true)
  })

  it.each([
    {}, { checks: [], grounding: finding() }, { checks: [finding()], grounding: finding() },
    { ...payload(), grounding: undefined }, { ...payload(), surprise: true },
    { checks: [{ requirement: 'Check', ...finding(), basis: ' ' }], grounding: finding() },
    { checks: [{ requirement: 'Check', ...finding(), status: 'complete' }], grounding: finding() },
    { checks: [{ requirement: 'Check', ...finding(), refs: [' '] }], grounding: finding() },
  ])('rejects malformed report arguments', async value => {
    await expect(recorded(value)).rejects.toThrow()
  })

  it('treats a broken latest report as invalid rather than as no report', async () => {
    const valid = await recorded()
    expect(checkResult([read(), valid, { ...valid, observation: '{broken' }], outputs, [source]).issues[0]).toContain('invalid')
  })

  it('requires a new verdict when missing evidence is read after a report', async () => {
    const verdict = await recorded()
    expect(verifyResult([verdict, read()], outputs, [source]).accepted).toBe(false)
    expect(verifyResult([verdict, read(), await recorded()], outputs, [source]).accepted).toBe(true)
    expect(verifyResult([read(), verdict, read(source)], outputs, [], true).issues.join(' ')).toContain('No usable source evidence')
  })

  it.each(['fail', 'unknown'])('keeps %s verdicts unresolved despite good readback', async status => {
    const value = payload(); value.grounding.status = status
    const result = checkResult([read(), await recorded(value)], outputs, [source])
    expect(result.accepted).toBe(false)
    expect(result.issues.join(' ')).toContain(`Source grounding: ${status}`)
  })

  it('invalidates any attempted mutation after the report, and accepts a new report after correction', async () => {
    const changed = checkResult([read(), await recorded(), { tool: 'press', args: { target: 'Save' }, observation: 'that did not work: failed' }], outputs, [source])
    expect(changed.issues.join(' ')).toContain('changed after')
    const next = 'C:/artifacts/revised-proposal.md'
    expect(checkResult([read(), await recorded(), create('proposal.md', next), read(next), await recorded()], outputs, [source]).accepted).toBe(true)
  })

  it('gives same-turn feedback from the steps the host observed', async () => {
    const tool = resultCheckTool({ outputs, sources: [source], requireSourceEvidence: true, generatedDirectory: 'C:/artifacts' })
    const missing = JSON.parse(await tool.run(payload(), { task: 'Check proposal', steps: [] })).validation
    expect(missing.accepted).toBe(false)
    expect(missing.issues.join(' ')).toContain('proposal.md')
    expect(JSON.parse(await tool.run(payload(), { task: 'Check proposal', steps: [read()] })).validation).toEqual({ accepted: true, issues: [] })
  })
})

describe('source grounding', () => {
  it('accepts an attachment or an original read, never only the generated output', () => {
    expect(checkResult([read()], outputs, [source]).accepted).toBe(true)
    expect(checkResult([read(source), read()], outputs, [], true, 'C:/artifacts').accepted).toBe(true)
    expect(checkResult([read()], outputs, [], true, 'C:/artifacts').issues.join(' ')).toContain('No usable source evidence')
    const web: TurnStep = { tool: 'read_open_page', args: {}, observation: 'Official policy: closed on Tuesdays.' }
    expect(checkResult([web, read()], outputs, [], true, 'C:/artifacts').accepted).toBe(true)
  })

  it('does not count failed reads, failed page verification or old generated files as sources', () => {
    const failed: TurnStep = { tool: 'read_open_page', args: {}, observation: 'that did not work: page closed' }
    expect(checkResult([failed, read()], outputs, [], true, 'C:/artifacts').accepted).toBe(false)
    const partial = { ...failed, observation: 'A frame timed out. This extract is incomplete; reobserve before claiming all requested fields were checked.' }
    expect(checkResult([partial, read()], outputs, [], true, 'C:/artifacts').accepted).toBe(false)
    const verify: TurnStep = { tool: 'verify', args: {}, observation: JSON.stringify({ verification: { status: 'failed' } }) }
    expect(checkResult([verify], [], [], true).accepted).toBe(false)
    verify.observation = JSON.stringify({ verification: { status: 'passed' } })
    expect(checkResult([verify], [], [], true).accepted).toBe(true)
    const old = 'C:/artifacts/old-proposal.md'
    expect(checkResult([read(old), read()], outputs, [old], true, 'C:/artifacts').accepted).toBe(false)
  })

  it.each(['C:/artifacts-backup/source.md', 'C:/fixtures/source.md'])('retains independent source reads outside the artifact directory (%s)', original => {
    expect(checkResult([read(original), read()], outputs, [], true, 'C:/artifacts').accepted).toBe(true)
  })

  it('rejects malformed source tables as the only source', () => {
    expect(checkResult([read(source, { tableValidation: { format: 'csv', valid: false } }), read()], outputs, [source]).accepted).toBe(false)
  })
})

describe('final output coverage', () => {
  it('preserves capture links without requiring media rereads', () => {
    const media = ['screen.png', 'recording.mp4', 'session.webm'].map(name => ({ name, path: `C:/artifacts/${name}` }))
    expect(checkResult([read()], [...outputs, ...media], [source]).accepted).toBe(true)
    expect(latestResultOutputs([read()], media)).toEqual(media)
    expect(checkResult([read()], [...outputs, { name: 'unsupported.zip', path: 'C:/artifacts/unsupported.zip' }], [source]).accepted).toBe(false)
  })

  it.each([
    { error: 'Failed' }, { ok: false }, { truncated: true }, { partial: true }, { nextOffset: 100 },
    { offset: 100 }, { completeReadback: false }, { observationMayBeStale: true }, { sha256: 'not-a-hash' },
    { characters: 999 }, { tableValidation: { valid: false, format: 'csv', error: { row: 2, column: 3, message: 'Extra field' } } },
  ])('rejects failed or partial output reads (%j)', extra => {
    expect(checkResult([read(path, extra)], outputs, [source]).accepted).toBe(false)
  })

  it('rejects a historical read and an unrelated successful read', () => {
    expect(checkResult([{ ...read(), seeded: true }], outputs, [source]).accepted).toBe(false)
    expect(checkResult([read('C:/artifacts/unrelated.md')], outputs, [source]).accepted).toBe(false)
  })

  it('requires every final output to be read', () => {
    const two = [...outputs, { name: 'budget.csv', path: 'C:/artifacts/budget.csv' }]
    expect(checkResult([read()], two, [source]).issues.join(' ')).toContain('budget.csv')
    expect(checkResult([read(), read(two[1]!.path)], two, [source]).accepted).toBe(true)
  })

  it('requires the latest created revision and a read after its last write', () => {
    const next = 'C:/artifacts/revised-proposal.md'
    expect(checkResult([read(), create('proposal.md', next)], outputs, [source]).accepted).toBe(false)
    expect(checkResult([read(next), create('proposal.md', next)], outputs, [source]).accepted).toBe(false)
    expect(checkResult([create(), read(path, { sha256: 'b'.repeat(64) })], [], [source]).accepted).toBe(false)
    expect(checkResult([create('proposal.md', next), read(next)], outputs, [source]).accepted).toBe(true)
  })

  it('uses the same latest successful output map for checking and delivery links', () => {
    const next = 'C:/artifacts/revised-proposal.md'
    const failed = { ...create('proposal.md', 'C:/artifacts/failed.md'), observation: JSON.stringify({ error: 'Write failed' }) }
    const steps = [create('proposal.md', next), failed, read(next)]
    const latest = latestResultOutputs(steps, outputs)
    expect(latest).toEqual([{ name: 'proposal.md', path: next, hash, after: 0 }])
    expect(checkResult(steps, latest, [source]).accepted).toBe(true)
    expect(latestResultOutputs([{ ...create('proposal.md', next), seeded: true }], outputs)).toEqual(outputs)
  })

  it('uses host table validation without mistaking quoted CSV content for extra columns', () => {
    const content = 'name,note\nexample,"comma, and\nnewline"\n'
    expect(checkResult([read(path, { content, tableValidation: { format: 'csv', valid: true, rows: 2, columns: 2 } })], outputs, [source]).accepted).toBe(true)
  })

  it('accepts explicit workbook readback but requires all known sheets and no selected range', () => {
    const book = 'C:/artifacts/report.xlsx'
    const made: TurnStep = { tool: 'file_create_workbook', args: { name: 'report.xlsx' }, observation: JSON.stringify({ path: book, sha256: hash, sheets: [{ sheet: 'A' }, { sheet: 'B' }] }) }
    const sheet = (name: string): TurnStep => ({ tool: 'file_read_workbook', args: { path: book, sheet: name }, observation: JSON.stringify({ path: book, sha256: hash, sheet: name, rows: [[1]], completeReadback: true }) })
    expect(checkResult([made, sheet('A')], [], [source]).accepted).toBe(false)
    expect(checkResult([made, sheet('A'), sheet('B')], [], [source]).accepted).toBe(true)
    const partial = sheet('B'); partial.args.range = 'A1'
    expect(checkResult([made, sheet('A'), partial], [], [source]).accepted).toBe(false)
  })

  it('requires all sheets from read receipts for a workbook created in an earlier turn', () => {
    const book = 'C:/artifacts/report.xlsx'
    const prior = [{ name: 'report.xlsx', path: book }]
    const sheet = (name: string, revision = hash): TurnStep => ({ tool: 'file_read_workbook', args: { path: book, sheet: name },
      observation: JSON.stringify({ path: book, sha256: revision, sheet: name, sheetNames: ['A', 'B'], rows: [[1]], completeReadback: true }) })
    expect(checkResult([sheet('A')], prior, [source]).accepted).toBe(false)
    expect(checkResult([sheet('A'), sheet('B')], prior, [source]).accepted).toBe(true)
    expect(checkResult([sheet('A'), sheet('B', 'b'.repeat(64))], prior, [source]).accepted).toBe(false)
  })

  it('accepts pages that together cover the whole text at one revision, overlaps included', () => {
    const page = (target: string, offset: number, content: string): TurnStep =>
      read(target, { content, characters: 6, offset, truncated: offset + content.length < 6, nextOffset: offset + content.length < 6 ? offset + content.length : null })
    expect(checkResult([page(path, 0, 'abc'), page(path, 3, 'def')], outputs, [source]).accepted).toBe(true)
    expect(checkResult([page(path, 0, 'abcd'), page(path, 2, 'cdef')], outputs, [source]).accepted).toBe(true)
    expect(checkResult([page(source, 0, 'abc'), page(source, 3, 'def'), read()], outputs, [], true, 'C:/artifacts').accepted).toBe(true)
    expect(checkResult([page(source, 0, 'abc'), read()], outputs, [], true, 'C:/artifacts').accepted).toBe(false)
  })

  it.each(['gap', 'hash', 'total'])('rejects broken paginated coverage (%s)', problem => {
    const first = read(path, { content: 'abc', characters: 6, truncated: true, nextOffset: 3 })
    const second = read(path, { content: 'def', characters: 6, offset: 3 })
    const value = JSON.parse(second.observation)
    if (problem === 'gap') { value.offset = 4; value.content = 'ef' }
    if (problem === 'hash') value.sha256 = 'b'.repeat(64)
    if (problem === 'total') { value.characters = 7; value.content = 'defg' }
    second.observation = JSON.stringify(value)
    expect(checkResult([first, second], outputs, [source]).accepted).toBe(false)
  })
})
