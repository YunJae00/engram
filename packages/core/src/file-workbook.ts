import type { AgentTool } from './agent-loop.js'
import { saveArtifact } from './file-work.js'

type Cell = string | number | boolean | null | { formula: string }
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

type Chart = { sheet: string; index: number; type: 'column' | 'bar' | 'line' | 'pie'; title?: string; top: number; left: number; bottom: number; right: number }
const CHART_TYPES = ['column', 'bar', 'line', 'pie']
const xml = (text: string): string => text.replace(/[&<>"]/g, mark => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[mark]!)
const column = (index: number): string => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name }
function chartXml(chart: Chart): string {
  const sheet = `'${chart.sheet.replaceAll("'", "''")}'!`
  const span = (col: number, from: number, to: number) => xml(`${sheet}$${column(col)}$${from + 1}:$${column(col)}$${to + 1}`)
  const series = Array.from({ length: chart.type === 'pie' ? 1 : chart.right - chart.left }, (_, at) => `<c:ser><c:idx val="${at}"/><c:order val="${at}"/><c:tx><c:strRef><c:f>${span(chart.left + 1 + at, chart.top, chart.top)}</c:f></c:strRef></c:tx>${chart.type === 'line' ? '<c:marker><c:symbol val="circle"/></c:marker>' : ''}<c:cat><c:strRef><c:f>${span(chart.left, chart.top + 1, chart.bottom)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${span(chart.left + 1 + at, chart.top + 1, chart.bottom)}</c:f></c:numRef></c:val></c:ser>`).join('')
  const axes = '<c:axId val="1"/><c:axId val="2"/>', flat = chart.type === 'bar'
  const plot = chart.type === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart>`
    : `${chart.type === 'line' ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>` : `<c:barChart><c:barDir val="${flat ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}${axes}</c:barChart>`}`
      + `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${flat ? 'l' : 'b'}"/><c:crossAx val="2"/></c:catAx>`
      + `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${flat ? 'b' : 'l'}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/></c:valAx>`
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`
}
async function withCharts(bytes: Buffer, charts: Chart[]): Promise<Buffer> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const put = (name: string, text: string) => zip.file(name, text, { createFolders: false })
  const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const edit = async (name: string, change: (text: string) => string) => {
    const text = await zip.file(name)?.async('string')
    if (text === undefined) throw new Error('The workbook package is not as expected. Nothing was saved.')
    const next = change(text)
    if (next === text) throw new Error('The workbook package is not as expected. Nothing was saved.')
    put(name, next)
  }
  let types = ''
  for (const [at, index] of [...new Set(charts.map(chart => chart.index))].entries()) {
    const own = charts.map((chart, number) => ({ chart, number: number + 1 })).filter(one => one.chart.index === index)
    const anchors = own.map(({ chart }, place) => {
      const col = chart.right + 2, row = chart.top + place * 17
      return `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${place + 2}" name="Chart ${place + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${RELS}" r:id="rId${place + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
    })
    put(`xl/drawings/drawing${at + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join('')}</xdr:wsDr>`)
    put(`xl/drawings/_rels/drawing${at + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE}">${own.map(({ number }, place) => `<Relationship Id="rId${place + 1}" Type="${RELS}/chart" Target="../charts/chart${number}.xml"/>`).join('')}</Relationships>`)
    for (const { chart, number } of own) put(`xl/charts/chart${number}.xml`, chartXml(chart))
    const rels = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, link = `<Relationship Id="rIdChart" Type="${RELS}/drawing" Target="../drawings/drawing${at + 1}.xml"/>`
    if (zip.file(rels)) await edit(rels, text => text.replace('</Relationships>', `${link}</Relationships>`))
    else put(rels, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE}">${link}</Relationships>`)
    await edit(`xl/worksheets/sheet${index + 1}.xml`, text => (text.includes('xmlns:r=') ? text : text.replace('<worksheet ', `<worksheet xmlns:r="${RELS}" `)).replace('</worksheet>', '<drawing r:id="rIdChart"/></worksheet>'))
    types += `<Override PartName="/xl/drawings/drawing${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>${own.map(({ number }) => `<Override PartName="/xl/charts/chart${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}`
  }
  await edit('[Content_Types].xml', text => text.replace('</Types>', `${types}</Types>`))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export function workbookTool(directory: string, assertActive?: () => void): AgentTool {
  const sheetSchema = { type: 'string', maxLength: 31 }
  const rowsSchema = { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'array', minItems: 1, maxItems: 100, items: { anyOf: [
    { type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
    { type: 'object', additionalProperties: false, properties: { formula: { type: 'string', maxLength: 1000 } }, required: ['formula'] },
  ] } } }
  return {
    name: 'file_create_workbook',
    description: 'Create a NEW .xlsx artifact, without opening an app. Supply sheet+rows for one sheet OR sheets:[{sheet,rows}] for up to 10 linked sheets. Never edits an existing workbook or preserves existing charts, macros or layout. Strings are literal; cells may be string/number/boolean/null or {formula:"A2*B2"} without leading =. Local arithmetic, SUM/MIN/MAX/AVERAGE/COUNT/COUNTA/IF/AND/OR/NOT/ROUND/ROUNDUP/ROUNDDOWN/ABS and references to supplied sheets are supported; no external references. Formula evaluation is NOT provided. Verify recalculated values in an application before claiming them. Total limit 10,000 cells/512 KB across all sheets. charts: [{type:"column|bar|line|pie", data:"A1:B13", title?, sheet?}] draws a chart beside the data, with no application: the first row of the range names the series and the first column the categories (pie uses the first series). The receipt carries the cells read back from the saved file (the first 30 rows of each sheet); read further rows with file_read_workbook only when a sheet has more. Serialized values alone do not verify business correctness. Use only when saving is allowed and provide the returned link.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 120, pattern: '\\.xlsx$', description: 'Plain output filename ending in .xlsx, e.g. recovery.xlsx. No directory.' }, sheet: sheetSchema, rows: rowsSchema,
      sheets: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { sheet: sheetSchema, rows: rowsSchema }, required: ['sheet', 'rows'] } },
      charts: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['type', 'data'], properties: { type: { type: 'string', enum: CHART_TYPES }, data: { type: 'string', description: 'The charted range with its header row and category column, e.g. A1:B13.' }, title: { type: 'string', maxLength: 120 }, sheet: sheetSchema } } },
    }, required: ['name'], oneOf: [{ required: ['sheet', 'rows'], not: { required: ['sheets'] } }, { required: ['sheets'], not: { anyOf: [{ required: ['sheet'] }, { required: ['rows'] }] } }] },
    async run(args, context) {
      context.signal?.throwIfAborted()
      if (Object.keys(args).some((key) => !['name', 'sheet', 'rows', 'sheets', 'charts'].includes(key))) throw new Error('Unsupported workbook argument.')
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
      const rawCharts = args.charts ?? []
      if (!Array.isArray(rawCharts) || rawCharts.length > 4) throw new Error('Supply at most 4 charts.')
      const charts = rawCharts.map((entry): Chart => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['type', 'data', 'title', 'sheet'].includes(key))) throw new Error('Each chart needs type and data, with an optional title and sheet.')
        const index = entry.sheet === undefined ? 0 : names.indexOf(entry.sheet), range = typeof entry.data === 'string' ? /^([A-Z]{1,2})([1-9]\d{0,3}):([A-Z]{1,2})([1-9]\d{0,3})$/.exec(entry.data.trim().toUpperCase()) : null
        if (index < 0 || !range || !CHART_TYPES.includes(entry.type) || (entry.title !== undefined && (typeof entry.title !== 'string' || entry.title.length > 120 || [...entry.title].some(character => character.charCodeAt(0) < 32)))) throw new Error('A chart needs a type (column, bar, line or pie), a data range like A1:B13 and a sheet that is supplied.')
        const at = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
        const left = at(range[1]!), right = at(range[3]!), top = Number(range[2]) - 1, bottom = Number(range[4]) - 1, rows = sheets[index]!.rows
        if (right <= left || bottom <= top || bottom >= rows.length || right >= rows[0]!.length) throw new Error('A chart range needs a header row, a category column and at least one more of each, inside the supplied rows.')
        return { sheet: names[index]!, index, type: entry.type, ...(entry.title?.trim() ? { title: entry.title.trim() } : {}), top, left, bottom, right }
      })
      const XLSX = await import('xlsx')
      const workbook = XLSX.utils.book_new()
      for (const { sheet, rows } of sheets) {
        const table = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(value => value && typeof value === 'object' ? { t: 'n', f: value.formula } : value)))
        XLSX.utils.book_append_sheet(workbook, table, sheet)
      }
      const plain = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      const bytes = charts.length ? await withCharts(plain, charts) : plain
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
      return JSON.stringify({ ...artifact, ...(args.sheets === undefined ? inspected[0] : {}), sheets: inspected, ...(charts.length ? { charts: charts.length } : {}),
        verification: `File bytes and serialized cell values/formulas verified. Formula calculation, formatting and application rendering NOT verified.${charts.length ? ' Charts are stored over their ranges; how they are drawn is not verified.' : ''}` })
    },
  }
}
