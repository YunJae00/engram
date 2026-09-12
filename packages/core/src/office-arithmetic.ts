import type { AgentLoopStep } from './agent-loop.js'

export interface Discrepancy { cell: string; expected: number; got: number }

function area(range: unknown) {
  if (typeof range !== 'string' || !/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(:\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/i.test(range)) return
  const points = range.replace(/\$/g, '').toUpperCase().split(':').map((cell) => {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(cell)!
    return { row: Number(digits), col: [...letters!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) }
  })
  const [start, end = start!] = points
  if (!start || start.row > end.row || start.col > end.col || end.row > 1048576 || end.col > 16384) return
  const height = end.row - start.row + 1, width = end.col - start.col + 1
  return height * width <= 4000 ? { ...start, height, width } : undefined
}

function cellName(row: number, col: number): string {
  let letters = ''
  while (col > 0) { letters = String.fromCharCode(65 + (col - 1) % 26) + letters; col = Math.floor((col - 1) / 26) }
  return `${letters}${row}`
}

// Only a read-back formula identifies a total. Numeric coincidences are not evidence.
// Other formulas and references outside this observation remain for the model to verify.
export function arithmeticDiscrepancies(rows: unknown[][], range?: string, formulas?: unknown[][], checked?: Set<string>): Discrepancy[] {
  const box = area(range)
  const rectangular = (grid: unknown): grid is unknown[][] => Array.isArray(grid) && grid.length === box?.height && grid.every(row => Array.isArray(row) && row.length === box.width)
  if (!box || !rectangular(rows) || !rectangular(formulas)) return []
  const out: Discrepancy[] = []
  for (let r = 0; r < box.height; r++) for (let c = 0; c < box.width; c++) {
    const formula = formulas[r]![c]
    const match = typeof formula === 'string' && /^=SUM\(\s*([^()]+?)\s*\)$/i.exec(formula)
    const sum = match && area(match[1])
    if (!sum || sum.row < box.row || sum.col < box.col || sum.row + sum.height > box.row + box.height || sum.col + sum.width > box.col + box.width) continue
    if (box.row + r >= sum.row && box.row + r < sum.row + sum.height && box.col + c >= sum.col && box.col + c < sum.col + sum.width) continue
    let expected = 0, valid = true
    for (let y = 0; y < sum.height; y++) for (let x = 0; x < sum.width; x++) {
      const value = rows[sum.row - box.row + y]![sum.col - box.col + x]
      if (typeof value === 'number') { if (!Number.isFinite(value)) valid = false; else expected += value }
      else if (typeof value === 'string' && value.startsWith('#')) valid = false
    }
    const got = rows[r]![c]
    if (valid && Number.isFinite(expected) && typeof got === 'number' && Number.isFinite(got)) checked?.add(cellName(box.row + r, box.col + c))
    if (valid && Number.isFinite(expected) && typeof got === 'number' && Number.isFinite(got) && Math.abs(expected - got) > Math.max(1e-9, Number.EPSILON * 64 * Math.max(Math.abs(expected), Math.abs(got)))) {
      out.push({ cell: cellName(box.row + r, box.col + c), expected, got })
    }
  }
  return out
}

export function officeArithmeticFault(steps: AgentLoopStep[]): string | undefined {
  const faults = new Map<string, string>()
  for (const step of steps) {
    if (step.tool !== 'excel_read' || step.seeded) continue
    try {
      const value = JSON.parse(step.observation)
      if (!value || value.error || value.truncated || value.reobserveRequired || value.observationMayBeStale || typeof value.workbook !== 'string' || typeof value.sheet !== 'string') continue
      const box = area(value.range)
      if (!box || !Array.isArray(value.rows) || value.rows.length !== box.height || !value.rows.every((row: unknown) => Array.isArray(row) && row.length === box.width)) continue
      const identity = JSON.stringify([value.workbook.toLowerCase(), value.sheet.toLowerCase()])
      const checked = new Set<string>()
      const current = arithmeticDiscrepancies(value.rows, value.range, value.formulas, checked)
      // Partial or values-only reads cannot clear a formula finding.
      if (Array.isArray(value.formulas) && value.formulas.length === box.height && value.formulas.every((row: unknown) => Array.isArray(row) && row.length === box.width)) {
        for (let r = 0; r < box.height; r++) for (let c = 0; c < box.width; c++) {
          const cell = cellName(box.row + r, box.col + c)
          if (checked.has(cell) || !/^=SUM\(/i.test(String(value.formulas[r][c]))) faults.delete(`${identity}:${cell}`)
        }
      }
      for (const fault of current) {
        faults.set(`${identity}:${fault.cell}`, `${value.workbook} / ${value.sheet} / ${fault.cell} shows ${fault.got}; its observed SUM formula evaluates to ${fault.expected}`)
      }
    } catch { /* Failed reads cannot replace previous evidence. */ }
  }
  return faults.size ? `A read-back SUM result does not add up: ${[...faults.values()].slice(0, 5).join('; ')}. Verify the calculation and read the affected cells again before reporting completion.` : undefined
}
