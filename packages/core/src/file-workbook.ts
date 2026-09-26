import type { AgentTool } from './agent-loop.js'
import { saveArtifact } from './file-work.js'

type Cell = string | number | boolean | null | { formula: string }
// Local formulas only. External references and executable spreadsheet features
// are not emitted; unfamiliar formulas remain a job for the live application.
const FUNCTIONS = new Set(['SUM', 'MIN', 'MAX', 'AVERAGE', 'COUNT', 'COUNTA', 'IF', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS'])
export function validateWorkbookFormula(value: string, sheets: string[] = []): string {
  const formula = value.toUpperCase()
  const local = formula.replace(/'(?:[^']|'')+'!|[A-Z_][A-Z0-9_.]*!/g, reference => {
    const name = reference.startsWith("'") ? reference.slice(1, -2).replaceAll("''", "'") : reference.slice(0, -1)
    if (!sheets.some(sheet => sheet.toUpperCase() === name)) throw new Error('Formula references an unknown or external sheet.')
    return ''
  })
  if (!formula || formula.length > 1000 || !/^[A-Z0-9$():,+*/. <>=^%-]+$/.test(local) || formula.startsWith('=')) throw new Error('Use a local formula without a leading = or external references.')
  for (const match of local.matchAll(/([A-Z][A-Z0-9_.]*)\s*\(/g)) if (!FUNCTIONS.has(match[1]!)) throw new Error(`Unsupported formula function: ${match[1]}. Use the live app instead.`)
  return formula
}
function cell(value: unknown, sheets: string[]): Cell {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 4000 && !value.includes('\0')) return value
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'formula' in value && typeof value.formula === 'string') {
    return { formula: validateWorkbookFormula(value.formula, sheets) }
  }
  throw new Error('Cells must be text, finite numbers, booleans, null or {formula}.')
}

export function workbookTool(directory: string, assertActive?: () => void): AgentTool {
  const sheetSchema = { type: 'string', maxLength: 31 }
  const rowsSchema = { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'array', minItems: 1, maxItems: 100, items: { anyOf: [
    { type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
    { type: 'object', additionalProperties: false, properties: { formula: { type: 'string', maxLength: 1000 } }, required: ['formula'] },
  ] } } }
  return {
    name: 'file_create_workbook',
    description: 'Create a NEW .xlsx artifact, without opening an app. Supply sheet+rows for one sheet OR sheets:[{sheet,rows}] for up to 10 linked sheets. Never edits an existing workbook or preserves existing charts, macros or layout. Strings are literal; cells may be string/number/boolean/null or {formula:"A2*B2"} without leading =. Local arithmetic, SUM/MIN/MAX/AVERAGE/COUNT/COUNTA/IF/AND/OR/NOT/ROUND/ROUNDUP/ROUNDDOWN/ABS and references to supplied sheets are supported; no external references. Formula evaluation is NOT provided. Verify recalculated values in an application before claiming them. Total limit 10,000 cells/512 KB across all sheets. Read every output sheet with file_read_workbook before reporting completion; serialized values alone do not verify business correctness. Use only when saving is allowed and provide the returned link.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 120, pattern: '\\.xlsx$', description: 'Plain output filename ending in .xlsx, e.g. recovery.xlsx. No directory.' }, sheet: sheetSchema, rows: rowsSchema,
      sheets: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { sheet: sheetSchema, rows: rowsSchema }, required: ['sheet', 'rows'] } },
    }, required: ['name'], oneOf: [{ required: ['sheet', 'rows'], not: { required: ['sheets'] } }, { required: ['sheets'], not: { anyOf: [{ required: ['sheet'] }, { required: ['rows'] }] } }] },
    async run(args, context) {
      context.signal?.throwIfAborted()
      if (Object.keys(args).some((key) => !['name', 'sheet', 'rows', 'sheets'].includes(key))) throw new Error('Unsupported workbook argument.')
      if (typeof args['name'] !== 'string' || !args['name'].endsWith('.xlsx')) throw new Error('Supply an .xlsx filename.')
      if (args.sheets !== undefined && (args.sheet !== undefined || args.rows !== undefined)) throw new Error('Use sheets or sheet+rows, not both.')
      const rawSheets = args.sheets ?? [{ sheet: args.sheet, rows: args.rows }]
      if (!Array.isArray(rawSheets) || !rawSheets.length || rawSheets.length > 10 || JSON.stringify(rawSheets).length > 512000) throw new Error('Supply 1 to 10 sheets, up to 512 KB total.')
      const names: string[] = []
      let count = 0
      for (const entry of rawSheets) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['sheet', 'rows'].includes(key))) throw new Error('Each sheet needs only sheet and rows.')
        const sheet = entry.sheet, raw = entry.rows
        if (typeof sheet !== 'string' || !sheet.trim() || sheet.length > 31 || /[[\]:*?/\\]/.test(sheet) || [...sheet].some(character => character.charCodeAt(0) < 32) || sheet.startsWith("'") || sheet.endsWith("'") || names.some(name => name.toUpperCase() === sheet.toUpperCase())) throw new Error('Supply distinct valid worksheet names.')
        names.push(sheet)
        if (!Array.isArray(raw) || !raw.length || raw.length > 1000 || !Array.isArray(raw[0]) || !raw[0].length || raw[0].length > 100 || raw.some(row => !Array.isArray(row) || row.length !== raw[0].length)) throw new Error('Supply rectangular sheets of up to 1000 rows and 100 columns.')
        count += raw.length * raw[0].length
      }
      if (count > 10000) throw new Error('Supply at most 10,000 cells across all sheets.')
      const sheets = rawSheets.map(entry => ({ sheet: entry.sheet as string, rows: (entry.rows as unknown[][]).map(row => row.map(value => cell(value, names))) }))
      const XLSX = await import('xlsx')
      const workbook = XLSX.utils.book_new()
      for (const { sheet, rows } of sheets) {
        const table = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(value => value && typeof value === 'object' ? { t: 'n', f: value.formula } : value)))
        XLSX.utils.book_append_sheet(workbook, table, sheet)
      }
      const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      const decodedWorkbook = XLSX.read(bytes, { type: 'buffer', sheetStubs: true })
      const inspected = sheets.map(({ sheet, rows }) => {
        const decoded = decodedWorkbook.Sheets[sheet]!
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
        return { sheet, rowCount: rows.length, columnCount: rows[0]!.length, rows: readback.slice(0, 30), truncated: rows.length > 30, formulaCount }
      })
      assertActive?.()
      const artifact = await saveArtifact(directory, args['name'], bytes, context.signal)
      return JSON.stringify({ ...artifact, ...(args.sheets === undefined ? inspected[0] : {}), sheets: inspected,
        verification: 'File bytes and serialized cell values/formulas verified. Formula calculation, formatting and application rendering NOT verified.' })
    },
  }
}
