import { describe, expect, it } from 'vitest'
import type { TurnStep } from 'core'
import { checkReport, checkResult as verifyResult, latestResultOutputs, resultCheckTool } from '../src/main/result-check.js'

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
    expect(checkResult([read(), await recorded()], outputs, [source])).toEqual({ accepted: true, verified: true, issues: [] })
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

  // qa145 B14 (S31/S32): a finished team report stopped as "일부를 확인하지 못했어요" on a guide rule that had nothing to apply to, reported unknown.
  it('does not hold a result back on a rule that has nothing to apply to, and does not show it', async () => {
    const rule = { requirement: '합계는 SUM 수식으로 입력(작업 가이드 규칙)', status: 'not_applicable', basis: '합계나 스프레드시트가 없어 적용 대상이 없음.' }
    const value = { ...payload(), checks: [...payload().checks, rule] }
    const step = await recorded(value)
    expect(checkResult([read(), step], outputs, [source])).toEqual({ accepted: true, verified: true, issues: [] })
    expect(checkReport([read(), step])!.checks.map(check => check.requirement)).toEqual(['Complete proposal'])
    // The same rule reported unknown, a missing outcome, an unsure grounding, and a report that set every requirement aside still stop the turn.
    expect(checkResult([read(), await recorded({ ...value, checks: [payload().checks[0], { ...rule, status: 'unknown' }] })], outputs, [source]).verified).toBe(false)
    expect(checkResult([read(), await recorded({ ...value, checks: [{ ...payload().checks[0], status: 'fail' }, rule] })], outputs, [source]).verified).toBe(false)
    expect(checkResult([read(), await recorded({ ...value, checks: [rule] })], outputs, [source]).issues.join(' ')).toContain('No requirement was checked')
    await expect(recorded({ ...value, grounding: { ...payload().grounding, status: 'not_applicable' } })).rejects.toThrow()
    expect(resultCheckTool().description).toContain('a mismatch you corrected and confirmed is pass')
  })

  it.each(['fail', 'unknown'])('keeps %s verdicts unresolved despite good readback', async status => {
    const value = payload(); value.grounding.status = status
    const result = checkResult([read(), await recorded(value)], outputs, [source])
    expect(result.accepted).toBe(true)
    expect(result.verified).toBe(false)
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
    expect(JSON.parse(await tool.run(payload(), { task: 'Check proposal', steps: [read()] })).validation).toEqual({ accepted: true, verified: true, issues: [] })
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
    expect(checkResult([read()], [...outputs, { name: 'unsupported.exe', path: 'C:/artifacts/unsupported.exe' }], [source]).accepted).toBe(false)
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

describe('the check, read back for the person', () => {
  it('carries each verdict with its basis and what was read, from the last valid report only', async () => {
    const page: TurnStep = { tool: 'open_page', args: { url: 'https://tms.example.com/report?week=41' }, observation: 'page' }
    const first = await recorded({ checks: [{ requirement: 'Old', status: 'fail', basis: 'stale' }], grounding: finding() })
    const steps = [read(source), page, first, create(), read(), await recorded()]
    expect(checkReport(steps, { generatedDirectory: 'C:/artifacts', attachments: ['C:/vault/.engram/chat-attachments/0d0d12a7-1b2c-4d5e-8f90-123456789abc-sales.csv'] })).toEqual({
      checks: [{ requirement: 'Complete proposal', status: 'pass', basis: 'Read the final result against the requested deliverable.' }],
      grounding: { status: 'pass', basis: 'The source supports the facts; unavailable pricing is explicitly an estimate, not a confirmed rate.' },
      sources: ['sales.csv', 'source.md', 'tms.example.com'],
    })
    expect(checkReport(steps)!.sources).toEqual(['source.md', 'tms.example.com', 'proposal.md'])
    expect(checkReport([read()])).toBeUndefined()
    expect(checkReport([{ tool: 'report_result_check', args: {}, observation: '{"resultCheck":{"checks":[]}}' }])).toBeUndefined()
  })
})

it('accepts an honest inaccessible source without verifying its claims', async () => {
  const value = payload()
  value.grounding.status = 'unknown'
  value.checks[0]!.status = 'fail'
  const result = verifyResult([{ tool: 'open_page', args: {}, observation: 'HTTP 403' }, await recorded(value)], [], [], true)
  expect(result.accepted).toBe(true)
  expect(result.verified).toBe(false)
  expect(result.issues).toHaveLength(2)
})

it('ends identical rejections on the third report while keeping defects visible and unverified', async () => {
  const tool = resultCheckTool({ outputs, sources: [source] })
  const steps: TurnStep[] = []
  for (let i = 0; i < 3; i++) {
    const observation = await tool.run(payload(), { task: 'Check', steps })
    const validation = JSON.parse(observation).validation
    expect(validation.accepted).toBe(i === 2)
    expect(validation.verified).toBe(false)
    steps.push({ tool: tool.name, args: payload(), observation })
  }
  expect(verifyResult(steps, outputs, [source]).accepted).toBe(true)
  expect(checkReport(steps)?.checks.some(check => check.status === 'unknown' && check.basis.includes('Reread'))).toBe(true)
})

it('uses successful structured batch pages as sources but rejects a wholly failed batch', async () => {
  for (const ready of [true, false]) {
    const batch: TurnStep = { tool: 'read_pages', args: {}, observation: JSON.stringify({ completed: ready ? 1 : 0, requested: 1, pages: [{ url: 'https://example.test', ready, observation: ready ? 'Actual source text' : '403 Forbidden' }] }) }
    const result = verifyResult([batch, await recorded()], [], [], true)
    expect(result.accepted).toBe(ready)
    expect(result.verified).toBe(ready)
  }
})

// qa142 p2b-r2 #1: the re-check's word that the delivered report stands is carried only when it is literally true.
it('carries reportUnchanged only when the report says true', async () => {
  expect(checkReport([await recorded({ ...payload(), reportUnchanged: true })])?.reportUnchanged).toBe(true)
  expect(checkReport([await recorded({ ...payload(), reportUnchanged: false })])).not.toHaveProperty('reportUnchanged')
  expect(checkReport([await recorded()])).not.toHaveProperty('reportUnchanged')
  await expect(resultCheckTool().run({ ...payload(), reportUnchanged: 'yes' }, { task: 'Prepare a proposal' })).rejects.toThrow()
})

// qa142 p2a-r4 #3: a script is a text deliverable; only real media skip the final-bytes check.
it('holds a script output to its final bytes: a full read, or the whole content the model wrote with its own write tool', async () => {
  const { createHash } = await import('node:crypto')
  const code = 'print("audited")\n', sha256 = createHash('sha256').update(code).digest('hex'), script = 'C:/artifacts/id-audit.py', task = 'C:/task/audit.py'
  const handIn: TurnStep = { tool: 'file_create_copy', args: { name: 'audit.py', fromPath: task }, observation: JSON.stringify({ path: script, sha256, completeReadback: true, handedInFrom: task }) }
  const wrote = (content: string, observation = 'Native action completed.'): TurnStep => ({ tool: 'Write', args: { file_path: task, content }, observation })
  const judge = async (before: TurnStep[]) => { const steps = [...before, await recorded(), handIn]; return verifyResult(steps, latestResultOutputs(steps, []), []) }
  const reread = 'Reread every final part of audit.py'
  // Written by nothing the host saw whole (a command, a patch without content): the bytes were never in front of the model.
  expect((await judge([])).issues.join(' ')).toContain(reread)
  expect((await judge([{ tool: 'Write', args: { file_path: task }, observation: 'Native action completed.' }])).issues.join(' ')).toContain(reread)
  // A command that printed or wrote the same text is not the model's write.
  expect((await judge([{ tool: 'Bash', args: { command: `cat > audit.py <<'X'\n${code}X`, content: code }, observation: code }])).issues.join(' ')).toContain(reread)
  // Its own write of exactly these bytes is the evidence; a write of other bytes, or one that did not land, is not.
  expect(await judge([wrote(code)])).toEqual({ accepted: true, verified: true, issues: [] })
  expect((await judge([wrote('print("draft")\n')])).issues.join(' ')).toContain(reread)
  // The same content written to another path, with a command writing the script itself: that write is not of this file.
  const elsewhere: TurnStep = { tool: 'Write', args: { file_path: 'C:/task/notes/audit-copy.py', content: code }, observation: 'Native action completed.' }
  const byCommand: TurnStep = { tool: 'Bash', args: { command: 'cp notes/audit-copy.py audit.py' }, observation: '' }
  expect((await judge([elsewhere, byCommand])).issues.join(' ')).toContain(reread)
  expect((await judge([{ tool: 'file_create_copy', args: { name: 'other.py', content: code }, observation: JSON.stringify({ path: 'C:/artifacts/id-other.py', taskPath: 'C:/task/other.py', sha256, completeReadback: true }) }, byCommand])).issues.join(' ')).toContain(reread)
  // Its own copy from content whose task-folder twin is the file handed in is a write of this file.
  expect((await judge([{ tool: 'file_create_copy', args: { name: 'audit.py', content: code }, observation: JSON.stringify({ path: 'C:/artifacts/id0-audit.py', taskPath: task, sha256, completeReadback: true }) }])).issues).toEqual([])
  expect((await judge([wrote(code, 'that did not work: Native action did not report success; it may have partly happened. Inspect the current state and do not repeat it.')])).issues.join(' ')).toContain(reread)
  expect((await judge([{ ...wrote(code), seeded: true }])).issues.join(' ')).toContain(reread)
  // The existing readback rule: the task file read in full at the handed-in hash.
  expect(await judge([read(task, { sha256, content: code })])).toEqual({ accepted: true, verified: true, issues: [] })
  expect((await judge([read(task, { content: code })])).issues.join(' ')).toContain(reread)
  // A script the model saved itself from content is the same proof; real media still need no text readback.
  const saved: TurnStep = { tool: 'file_create_copy', args: { name: 'audit.py', content: code }, observation: JSON.stringify({ path: script, sha256, completeReadback: true }) }
  expect(verifyResult([saved, await recorded()], latestResultOutputs([saved], []), [])).toEqual({ accepted: true, verified: true, issues: [] })
  const copied: TurnStep = { ...saved, args: { name: 'audit.py', fromPath: task } }
  expect(verifyResult([copied, await recorded()], latestResultOutputs([copied], []), []).issues.join(' ')).toContain(reread)
  for (const name of ['shot.png', 'clip.mp4', 'report.pdf', 'bundle.zip']) expect(checkResult([create(name, `C:/artifacts/${name}`)], [], []).issues).toEqual([])
})
