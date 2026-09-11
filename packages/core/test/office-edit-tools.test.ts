import { expect, it, vi } from 'vitest'
import { officeEditTools } from '../src/office-edit-tools.js'

const revision = 'a'.repeat(32)
const file = 'C:\\test.docx'
const edits = [{ kind: 'append', text: 'Text' }]
it('binds document reads to a chat and consumes them before failed mutations', async () => {
  const run = vi.fn().mockResolvedValue({ revision })
  const tools = officeEditTools({ run })
  const other = officeEditTools({ run })
  const invoke = (name: string, args: Record<string, unknown>, set = tools) => set.find((t) => t.name === name)!.run(args, { task: 'Edit document' })
  await invoke('word_read', { file })
  await expect(invoke('word_edit', { file, revision, edits }, other)).rejects.toThrow('this chat')
  run.mockRejectedValueOnce(new Error('connection closed'))
  await expect(invoke('word_edit', { file, revision, edits })).rejects.toThrow('connection closed')
  await expect(invoke('word_edit', { file, revision, edits })).rejects.toThrow('this chat')
  expect(run).toHaveBeenCalledTimes(2)
})

it.each(['relative.docx', '\\root.docx', 'C:\\x.docm', 'C:\\x.docx:stream', '\\\\?\\C:\\x.docx'])('refuses ambiguous or unsupported paths: %s', async (file) => {
  const run = vi.fn()
  const tool = officeEditTools({ run }).find((t) => t.name === 'word_read')!
  await expect(tool.run({ file }, { task: 'read' })).rejects.toThrow('absolute path')
  expect(run).not.toHaveBeenCalled()
})

it.each([
  { edits: [{ kind: 'text', slide: 0, shape: 1, text: 'x' }] },
  { edits: [{ kind: 'text', slide: 1.5, shape: 1, text: 'x' }] },
  { edits: [{ kind: 'replace', find: '', with: 'x' }] },
  { save: 'yes' },
  { save: true, saveAs: 'C:\\copy.pptx' },
  { saveAs: 'C:\\TEST.pptx' },
])('rejects invalid edits even with a valid observation (%#)', async (extra) => {
  const run = vi.fn().mockResolvedValue({ revision })
  const tools = officeEditTools({ run })
  const file = 'C:\\test.pptx'
  await tools.find((t) => t.name === 'ppt_read')!.run({ file }, { task: 'read' })
  await expect(tools.find((t) => t.name === 'ppt_edit')!.run({ file, revision, edits: [{ kind: 'text', slide: 1, shape: 1, text: 'x' }], ...extra }, { task: 'edit' })).rejects.toThrow()
  expect(run).toHaveBeenCalledOnce()
})
