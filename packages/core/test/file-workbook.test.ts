import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { workbookTool } from '../src/file-workbook.js'
import { fileWorkTools } from '../src/file-work.js'

it('includes the complete sheet manifest in saved workbook reads, even for a selected range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engram-workbook-read-'))
  try {
    const context = { task: 'Read both sheets in this saved workbook.' }
    const output = JSON.parse(await workbookTool(root).run({ name: 'summary.xlsx', sheets: [
      { sheet: 'Summary', rows: [['Total'], [10]] }, { sheet: 'Evidence', rows: [['Item', 'Value'], ['Source', 10]] },
    ] }, context))
    const reader = fileWorkTools({ directory: root, approveRead: async () => true }).find(tool => tool.name === 'file_read_workbook')!
    const full = JSON.parse(await reader.run({ path: output.path, sheet: 'Summary' }, context))
    expect(full).toMatchObject({ sheet: 'Summary', sheetNames: ['Summary', 'Evidence'], completeReadback: true, sha256: output.sha256 })
    expect(full.rows).toHaveLength(2)
    const partial = JSON.parse(await reader.run({ path: output.path, sheet: 'Evidence', range: 'A1' }, context))
    expect(partial.sheetNames).toEqual(['Summary', 'Evidence'])
    expect(partial.rows).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('adds charts to a new workbook as package parts, with no application, and still reads every cell back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engram-workbook-chart-'))
  try {
    const context = { task: 'Monthly totals with a chart.' }
    const tool = workbookTool(root)
    const rows = [['월', '합계', '건수'], ['1월', 3529000, 4], ['2월', 2781000, 4], ['3월', 2836000, 4]]
    const output = JSON.parse(await tool.run({ name: 'monthly.xlsx', sheets: [{ sheet: '요약', rows: [['총계'], [9146000]] }, { sheet: "월별 '합'계", rows }],
      charts: [{ type: 'column', data: 'A1:B4', title: '월별 <매출> & 합계', sheet: "월별 '합'계" }, { type: 'pie', data: 'a1:c4', sheet: "월별 '합'계" }, { type: 'line', data: 'A1:B4', sheet: "월별 '합'계" }] }, context))
    expect(output).toMatchObject({ charts: 3, completeReadback: true })
    const { default: JSZip } = await import('jszip')
    const { readFile } = await import('node:fs/promises')
    const zip = await JSZip.loadAsync(await readFile(output.path))
    const text = (name: string) => zip.file(name)!.async('string')
    expect(Object.keys(zip.files).filter(name => /^xl\/(charts|drawings)\//.test(name)).sort()).toEqual(['xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/charts/chart3.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/drawings/drawing1.xml'])
    const chart = await text('xl/charts/chart1.xml')
    expect(chart).toContain("<c:f>'월별 ''합''계'!$A$2:$A$4</c:f>")
    expect(chart).toContain("<c:f>'월별 ''합''계'!$B$2:$B$4</c:f>")
    expect(chart).toContain('<a:t>월별 &lt;매출&gt; &amp; 합계</a:t>')
    expect(chart).toContain('<c:barDir val="col"/>')
    expect((await text('xl/charts/chart2.xml')).match(/<c:ser>/g)).toHaveLength(1)
    expect(await text('xl/charts/chart3.xml')).toContain('<c:lineChart>')
    // The chart hangs on the second sheet only, and the package names every new part.
    expect(await text('xl/worksheets/sheet2.xml')).toMatch(/xmlns:r="[^"]+".*<drawing r:id="rIdChart"\/><\/worksheet>$/s)
    expect(await text('xl/worksheets/sheet1.xml')).not.toContain('<drawing')
    expect(await text('xl/worksheets/_rels/sheet2.xml.rels')).toContain('Target="../drawings/drawing1.xml"')
    expect((await text('xl/drawings/_rels/drawing1.xml.rels')).match(/charts\/chart\d\.xml/g)).toEqual(['charts/chart1.xml', 'charts/chart2.xml', 'charts/chart3.xml'])
    const types = await text('[Content_Types].xml')
    for (const part of ['/xl/drawings/drawing1.xml', '/xl/charts/chart1.xml', '/xl/charts/chart3.xml']) expect(types).toContain(`PartName="${part}"`)
    const { DOMParser } = await import('@xmldom/xmldom')
    for (const part of ['xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/charts/chart3.xml', 'xl/drawings/drawing1.xml']) {
      const source = await text(part)
      expect(() => new DOMParser({ onError: (level, message) => { throw new Error(`${level}: ${message}`) } }).parseFromString(source, 'text/xml')).not.toThrow()
    }
    const reader = fileWorkTools({ directory: root, approveRead: async () => true }).find(one => one.name === 'file_read_workbook')!
    const read = JSON.parse(await reader.run({ path: output.path, sheet: "월별 '합'계" }, context))
    expect(read.rows[1].map((cell: { value: unknown }) => cell.value)).toEqual(['1월', 3529000, 4])
    for (const charts of [[{ type: 'column', data: 'A1:B9' }], [{ type: 'column', data: 'A1:A4' }], [{ type: 'area', data: 'A1:B4' }], [{ type: 'pie', data: 'A1:B4', sheet: 'Nowhere' }], [{ type: 'pie', data: 'Sheet2!A1:B4' }]])
      await expect(tool.run({ name: 'bad.xlsx', sheet: 'S', rows, charts }, context)).rejects.toThrow(/chart/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})
