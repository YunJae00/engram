import { describe, expect, it } from 'vitest'
import { arithmeticDiscrepancies, officeArithmeticFault } from '../src/office-arithmetic.js'
import type { AgentLoopStep } from '../src/agent-loop.js'
import { checkOfficeResult } from '../src/office-verification.js'

const rows = [[10, 20, 30], [20, 30, 50], [30, 50, 999]]
const formulas = [[10, 20, '=SUM(A1:B1)'], [20, 30, '=SUM(A2:B2)'], ['=SUM(A1:A2)', '=SUM(B1:B2)', '=SUM(C1:C2)']]
function read(over: Record<string, unknown> = {}): AgentLoopStep {
  return { tool: 'excel_read', args: {}, observation: JSON.stringify({ workbook: 'Report.xlsx', sheet: 'Totals', range: 'A1:C3', rows, formulas, ...over }) }
}

describe('observed arithmetic', () => {
  it('checks an actual total even without matching neighbouring totals', () => {
    expect(arithmeticDiscrepancies([[100], [50], [999]], 'B8:B10', [[100], [50], ['=SUM($B$8:$B$9)']])).toEqual([{ cell: 'B10', expected: 150, got: 999 }])
  })
  it('never infers totals from coincidentally matching rows or labels', () => {
    expect(arithmeticDiscrepancies(rows, 'A1:C3')).toEqual([])
    expect(arithmeticDiscrepancies(rows, 'A1:C3', rows)).toEqual([])
  })
  it('uses numeric stored values, including percentages and negatives, not formatted text', () => {
    expect(arithmeticDiscrepancies([[0.1, -100], [0.2, 200], [0.3, 100]], 'A1:B3', [[0.1, -100], [0.2, 200], ['=SUM(A1:A2)', '=SUM(B1:B2)']])).toEqual([])
    expect(arithmeticDiscrepancies([['1,000'], [2], [2]], 'A1:A3', [['1,000'], [2], ['=SUM(A1:A2)']])).toEqual([])
  })
  it('does not invent evaluation for partial, invalid, external or unsupported formulas', () => {
    for (const formula of ['=SUM(B1:B2)', '=SUM(A1:A999999)', '=SUM(A1:A3)', '=SUM(Other!A1:A2)', '=AVERAGE(A1:A2)']) {
      expect(arithmeticDiscrepancies([[1], [2], [999]], 'A1:A3', [[1], [2], [formula]])).toEqual([])
    }
    expect(arithmeticDiscrepancies(rows, 'A0:C3', formulas)).toEqual([])
    expect(arithmeticDiscrepancies(rows, 'A1:C4', formulas)).toEqual([])
  })
})

describe('turn verification', () => {
  it('flags a wrong formula and clears it after a fresh corrected read', () => {
    expect(officeArithmeticFault([read()])).toContain('Report.xlsx / Totals / C3')
    expect(officeArithmeticFault([read(), read({ rows: [[10, 20, 30], [20, 30, 50], [30, 50, 80]] })])).toBeUndefined()
    expect(officeArithmeticFault([read(), read({ rows: [[10, 20, 30], [20, 30, 50], [30, 50, 80]], sheet: 'Other' })])).toContain('Totals')
  })
  it.each([{ truncated: true }, { observationMayBeStale: true }, { reobserveRequired: true }, { error: 'failed' }, { formulas: undefined }, { range: 'C3', rows: [[80]], formulas: [['=SUM(C1:C2)']] }])('does not clear an earlier error with insufficient evidence: %j', over => {
    expect(officeArithmeticFault([read(), read(over)])).toContain('does not add up')
  })
  it('ignores invalid and seeded evidence', () => {
    expect(officeArithmeticFault([read({ error: 'failed' })])).toBeUndefined()
    expect(officeArithmeticFault([{ ...read(), seeded: true }])).toBeUndefined()
  })
  it('marks the step-loop answer unverified without changing a user question', () => {
    const result = { answer: 'Done', steps: [read()], fellBack: false }
    expect(checkOfficeResult(result).incomplete).toContain('SUM')
    expect(checkOfficeResult({ ...result, asked: true })).toMatchObject({ answer: 'Done', asked: true })
  })
})
