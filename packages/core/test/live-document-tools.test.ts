import { describe, expect, it, vi } from 'vitest'
import { liveDocumentTools } from '../src/live-document-tools.js'
import { desktopStepArgs, isDesktopTool } from '../src/desktop-tools.js'
import { workCapabilities } from '../src/work-capabilities.js'

const snapshot = 'a'.repeat(32)
const context = { task: 'Edit the test document.' }
describe('live document boundary', () => {
  it('offers model-designed composition across documents with redacted receipts', async () => {
    const native = vi.fn(async () => '{}')
    const tools = liveDocumentTools(native)
    const compose = tools.find(tool => tool.name === 'compose_live_document')!
    for (const payload of [
      { paragraphs: [{ text: 'A new section', fontSize: 18, bold: true, color: '#102030' }] },
      { format: { autoFit: true, numberFormat: '#,##0' } },
      { slides: [{ boxes: [{ text: 'A new idea', x: 30, y: 30, width: 700, height: 60, fontSize: 28, color: '102030' }] }] },
    ]) await compose.run({ snapshot, ...payload }, context)
    expect(native).toHaveBeenCalledTimes(3)
    expect(isDesktopTool(compose.name)).toBe(true)
    expect(desktopStepArgs(compose.name, { snapshot, paragraphs: [{ text: 'private' }] })).toEqual({ snapshot, composition: '[redacted]' })
    expect(JSON.parse(await workCapabilities(tools).run({}, context)).liveDocumentApi.tools.map((tool: {name: string}) => tool.name)).toContain(compose.name)
  })
  it('refuses malformed composition, arbitrary code and unbounded layouts before dispatch', async () => {
    const native = vi.fn(async () => '{}')
    const compose = liveDocumentTools(native).find(tool => tool.name === 'compose_live_document')!
    const box = { text: 'Title', x: 0, y: 0, width: 200, height: 50, fontSize: 30, color: '000000' }
    for (const payload of [
      {}, { paragraphs: [] }, { paragraphs: [{ text: '\u0000' }] },
      { paragraphs: [{ text: 'ok', script: 'execute' }] },
      { paragraphs: [{ text: 'ok' }], format: { bold: true } },
      { slides: [{ boxes: [{ ...box, width: Infinity }] }] },
      { slides: [{ boxes: [{ ...box, fontSize: 0 }] }] },
      { slides: [{ boxes: [{ ...box, color: 'red' }] }] },
      { format: { numberFormat: '[external]' } }, { format: {} },
    ]) await expect(compose.run({ snapshot, ...payload }, context)).rejects.toThrow()
    expect(native).not.toHaveBeenCalled()
  })
  it('routes bounded native reads and bulk edits, never app scripts', async () => {
    const native = vi.fn(async () => '{"live":true}')
    const tools = liveDocumentTools(native)
    await tools[0]!.run({ app: 'Test - Word', offset: 0 }, context)
    const edits = [{ id: 'b0', expected: 'Old title', before: 'Old', after: 'New' }]
    await tools[1]!.run({ snapshot, edits }, context)
    expect(native.mock.calls).toHaveLength(2)
    expect(native).toHaveBeenLastCalledWith('documentEdit', { snapshot, edits }, context)
    await tools[1]!.run({ snapshot, edits: [{id:'b0',expected:'',before:'',after:'=SUM(B2:B4)'}] }, context)
    expect(isDesktopTool('read_live_document')).toBe(true)
    expect(isDesktopTool('edit_live_document')).toBe(true)
    expect(desktopStepArgs('edit_live_document', { snapshot, edits })).toEqual({ snapshot, edits: '[redacted]' })
    expect(JSON.parse(await workCapabilities(tools).run({}, context)).liveDocumentApi.available).toBe(true)
  })
  it('rejects arbitrary paths, commands, duplicate IDs and unsafe formulas before dispatch', async () => {
    const native = vi.fn(async () => '{}')
    const [read, edit] = liveDocumentTools(native)
    for (const args of [{ app: '' }, { range: '[secret.xlsx]Sheet1!A1' }, { range: 'A0' }, { offset: -1 }, { script: 'anything' }]) await expect(read!.run(args, context)).rejects.toThrow()
    const one = { id: 'b0', expected: '', before: '', after: 'x' }
    for (const args of [
      { snapshot, edits: [] }, { snapshot, edits: [one, one] },
      { snapshot, edits: [{...one, after: '=WEBSERVICE("https://example.com")'}] },
      { snapshot, edits: [{...one, after: '\u0000'}] },
      { snapshot, edits: [one], script: 'anything' },
      { snapshot, edits: [{...one, after: 'x'.repeat(8001)}] },
    ]) await expect(edit!.run(args, context)).rejects.toThrow()
    expect(native).not.toHaveBeenCalled()
  })
  it('preserves abort instead of switching to another editing method', async () => {
    const native = vi.fn(async () => '{}')
    const tools = liveDocumentTools(native)
    const signal = AbortSignal.abort(new Error('Stopped'))
    for(const tool of tools) await expect(tool.run({}, { ...context, signal })).rejects.toThrow('Stopped')
    expect(native).not.toHaveBeenCalled()
  })
})
