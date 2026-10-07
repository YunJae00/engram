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
