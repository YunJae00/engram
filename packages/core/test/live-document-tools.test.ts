import { describe, expect, it, vi } from 'vitest'
import { liveDocumentTools } from '../src/live-document-tools.js'
import { desktopStepArgs, isDesktopTool } from '../src/desktop-tools.js'
import { workCapabilities } from '../src/work-capabilities.js'

const snapshot = 'a'.repeat(32)
const context = { task: 'Edit the test document.' }
describe('live document boundary', () => {
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
