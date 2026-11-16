import { expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ bind: vi.fn(), show: vi.fn() }))
vi.mock('electron', () => ({ screen: {} }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: fake.bind }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: fake.show, officeWorkPreview: vi.fn() }))
vi.mock('../src/main/office-host.js', () => ({}))
vi.mock('../src/main/desktop-control.js', () => ({}))
vi.mock('../src/main/application-work.js', () => ({}))
import { showOfficePreview } from '../src/main/office-agent.js'
it.each([['outlook.mail', 'Outlook', undefined], ['excel.workbooks', 'Excel', undefined], ['word.read', 'Word', ''], ['ppt.read', 'PowerPoint', '']] as const)('binds %s for a read-only window preview', async (op, app, window) => {
  const binding = { lane: 'one', name: app }
  fake.bind.mockResolvedValueOnce(binding)
  await showOfficePreview('one', op, window)
  expect(fake.bind).toHaveBeenLastCalledWith('one', { app })
  expect(fake.show).toHaveBeenLastCalledWith(binding)
})
// QA145 S02: "do not open Word" still showed a live card of the person's own Word window.
it.each(['word.read', 'word.edit', 'ppt.read', 'excel.read'] as const)('%s attaches no window until the command names the one it works in', async (op) => {
  fake.bind.mockClear(); fake.show.mockClear()
  await showOfficePreview('one', op)
  expect(fake.bind).not.toHaveBeenCalled()
  expect(fake.show).not.toHaveBeenCalled()
  const binding = { lane: 'one', name: 'report.docx' }
  fake.bind.mockResolvedValueOnce(binding)
  await showOfficePreview('one', op, '4821')
  expect(fake.bind).toHaveBeenLastCalledWith('one', { app: 'window:4821:0' })
  expect(fake.show).toHaveBeenLastCalledWith(binding)
})
it('keeps the activity fallback when binding fails', async () => {
  fake.show.mockClear(); fake.bind.mockRejectedValueOnce(new Error('No open window'))
  await expect(showOfficePreview('one', 'outlook.mail')).resolves.toBeUndefined()
  expect(fake.show).not.toHaveBeenCalled()
})
