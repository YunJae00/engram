import type { AgentTool } from './agent-loop.js'
import { saveArtifact } from './file-work.js'

type Cell = string | number | boolean | null | { formula: string }
// Local formulas only. External references and executable spreadsheet features
// are not emitted; unfamiliar formulas remain a job for the live application.
const FUNCTIONS = new Set(['SUM', 'MIN', 'MAX', 'AVERAGE', 'COUNT', 'COUNTA', 'IF', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS'])
export function validateWorkbookFormula(value: string): string {
  const formula = value.toUpperCase()
  if (!formula || formula.length > 1000 || !/^[A-Z0-9$():,+*/. <>=^%-]+$/.test(formula) || formula.startsWith('=')) throw new Error('Use a local formula without a leading = or external references.')
  for (const match of formula.matchAll(/([A-Z][A-Z0-9_.]*)\s*\(/g)) if (!FUNCTIONS.has(match[1]!)) throw new Error(`Unsupported formula function: ${match[1]}. Use the live app instead.`)
  return formula
}
function cell(value: unknown): Cell {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 4000 && !value.includes('\0')) return value
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'formula' in value && typeof value.formula === 'string') {
    return { formula: validateWorkbookFormula(value.formula) }
  }
  throw new Error('Cells must be text, finite numbers, booleans, null or {formula}.')
}

export function workbookTool(directory: string, assertActive?: () => void): AgentTool {
  return {
    name: 'file_create_workbook',
    description: 'Create a NEW .xlsx artifact from a rectangular table in one call, without opening an app. Never edits an existing workbook or preserves an existing document\'s charts, macros or layout. Strings are literal, not formulas. Cells may be string/number/boolean/null or {formula: "A2*B2"} with no leading =. Local arithmetic and SUM/MIN/MAX/AVERAGE/COUNT/COUNTA/IF/AND/OR/NOT/ROUND/ROUNDUP/ROUNDDOWN/ABS are supported; no external references. Formula evaluation is NOT provided: verify recalculated values in the application before claiming them. Up to 10,000 cells. Returns saved values and formulas read back from the output. Use only when creating a saved artifact is allowed and provide its returned link.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 120 }, sheet: { type: 'string', maxLength: 31 },
      rows: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'array', minItems: 1, maxItems: 100, items: { anyOf: [
        { type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
        { type: 'object', additionalProperties: false, properties: { formula: { type: 'string', maxLength: 1000 } }, required: ['formula'] },
      ] } } },
    }, required: ['name', 'sheet', 'rows'] },
    async run(args, context) {
      context.signal?.throwIfAborted()
      if (Object.keys(args).some((key) => !['name', 'sheet', 'rows'].includes(key))) throw new Error('Unsupported workbook argument.')
      if (typeof args['name'] !== 'string' || !args['name'].endsWith('.xlsx')) throw new Error('Supply an .xlsx filename.')
      const sheet = args['sheet']
      if (typeof sheet !== 'string' || !sheet.trim() || sheet.length > 31 || /[[\]:*?/\\]/.test(sheet) || [...sheet].some((character) => character.charCodeAt(0) < 32) || sheet.startsWith("'") || sheet.endsWith("'")) throw new Error('Supply a valid worksheet name.')
      const raw = args['rows']
      if (!Array.isArray(raw) || !raw.length || raw.length > 1000 || !Array.isArray(raw[0]) || !raw[0].length || raw[0].length > 100 || raw.length * raw[0].length > 10000
        || raw.some((row) => !Array.isArray(row) || row.length !== raw[0].length) || JSON.stringify(raw).length > 512000) throw new Error('Supply a rectangular table of at most 10,000 cells and 512 KB.')
      const rows = (raw as unknown[][]).map((row) => row.map(cell))
      const XLSX = await import('xlsx')
      const table = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((value) => value && typeof value === 'object' ? { t: 'n', f: value.formula } : value)))
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, table, sheet)
      const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      const decoded = XLSX.read(bytes, { type: 'buffer', sheetStubs: true }).Sheets[sheet]!
      let formulaCount = 0
      const readback = rows.map((row, r) => row.map((value, c) => {
        const actual = decoded[XLSX.utils.encode_cell({ r, c })] as { v?: unknown; f?: string } | undefined
        if (value && typeof value === 'object') {
          if (actual?.f !== value.formula) throw new Error('Formula serialization did not match. Nothing was saved.')
          formulaCount++
          return { formula: actual.f, calculatedValue: 'not verified' }
        }
        if ((actual?.v ?? null) !== value) throw new Error('Cell serialization did not match. Nothing was saved.')
        return value
      }))
      assertActive?.()
      const artifact = await saveArtifact(directory, args['name'], bytes, context.signal)
      return JSON.stringify({ ...artifact, sheet, rowCount: rows.length, columnCount: rows[0]!.length,
        rows: readback.slice(0, 30), truncated: rows.length > 30, formulaCount,
        verification: 'File bytes and serialized cell values/formulas verified. Formula calculation, formatting and application rendering NOT verified.' })
    },
  }
}
