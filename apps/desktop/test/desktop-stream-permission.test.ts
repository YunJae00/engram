import { afterEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ prepare: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/renderer/src/api.js', () => ({ api: { desktopPrepareCapture: fake.prepare, desktopCancelCapture: fake.cancel } }))
import { openDesktopStream } from '../src/renderer/src/lib/desktopStream.js'
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('skips getDisplayMedia when the main-process screen preflight denies capture', async () => {
  const capture = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } })
  fake.prepare.mockResolvedValue({ denied: 'screen_recording' })
  await expect(openDesktopStream('bot-one')).rejects.toThrow('screen_recording_denied')
  expect(capture).not.toHaveBeenCalled()
  expect(fake.cancel).not.toHaveBeenCalled()
})
it('uses and consumes a granted display token normally', async () => {
  const stream = { getTracks: () => [] }
  const capture = vi.fn().mockResolvedValue(stream)
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } })
  fake.prepare.mockResolvedValue('token')
  await expect(openDesktopStream('bot-one')).resolves.toBe(stream)
  expect(capture).toHaveBeenCalledOnce()
  expect(fake.cancel).toHaveBeenCalledWith('token')
})
