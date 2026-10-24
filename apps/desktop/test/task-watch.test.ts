import { beforeEach, expect, it, vi } from 'vitest'
import { peekWatch, watchKeys } from '../src/main/task-watch.js'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  tools: vi.fn(),
  run: vi.fn(),
}))
vi.mock('../src/main/settings.js', () => ({ loadSettings: mocks.settings }))
vi.mock('../src/main/office-agent.js', () => ({ officeAgentTools: mocks.tools }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue({ computerUse: true, appsOff: [] })
  mocks.run.mockResolvedValue(JSON.stringify({ items: [{ id: 'mail-1' }] }))
  mocks.tools.mockReturnValue([{ name: 'outlook_mail', run: mocks.run }])
})

it('keeps stable keys for listings, including items without ids', () => {
  expect(watchKeys('{"items":[{"id":"a"}]}')).toEqual([{ key: 'a', id: 'a' }])
  expect(watchKeys('[]')).toEqual([])
  const raw = '[{"subject":"A"}]'
  expect(watchKeys(raw)).toEqual(watchKeys(raw))
  expect(watchKeys(raw)).not.toEqual(watchKeys('[{"subject":"B"}]'))
  expect(() => watchKeys('not json')).toThrow()
})

it('only calls a read-only listing, preserving its arguments and timeout', async () => {
  expect(await peekWatch({ tool: 'outlook_mail', args: { folder: 'inbox' } })).toEqual([{ key: 'mail-1', id: 'mail-1' }])
  expect(mocks.run).toHaveBeenCalledWith({ folder: 'inbox' }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  mocks.run.mockClear()
  expect(await peekWatch({ tool: 'outlook_draft', args: {} })).toBeNull()
  expect(mocks.run).not.toHaveBeenCalled()
})

it('does not read when app work or Outlook is off, or its tool is unavailable', async () => {
  mocks.settings.mockResolvedValueOnce({ computerUse: false, appsOff: [] })
  expect(await peekWatch({ tool: 'outlook_mail', args: {} })).toBeNull()
  mocks.settings.mockResolvedValueOnce({ computerUse: true, appsOff: [{ app: 'olk', label: 'Outlook' }] })
  expect(await peekWatch({ tool: 'outlook_mail', args: {} })).toBeNull()
  mocks.tools.mockReturnValueOnce([])
  expect(await peekWatch({ tool: 'outlook_mail', args: {} })).toBeNull()
  expect(mocks.run).not.toHaveBeenCalled()
})
