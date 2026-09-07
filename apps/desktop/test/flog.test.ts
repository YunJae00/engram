import { beforeEach, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ mkdir: vi.fn(), stat: vi.fn(), rename: vi.fn(), appendFile: vi.fn() }))
vi.mock('node:fs/promises', () => fs)
vi.mock('electron', () => ({ app: { getPath: () => '/test-userdata' } }))

beforeEach(() => {
  vi.resetModules()
  for (const mock of Object.values(fs)) mock.mockReset()
  fs.mkdir.mockResolvedValue(undefined)
  fs.stat.mockResolvedValue({ size: 0 })
  fs.rename.mockResolvedValue(undefined)
  fs.appendFile.mockResolvedValue(undefined)
})

it('returns immediately while the asynchronous log write is blocked', async () => {
  let release!: () => void
  fs.appendFile.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
  const { flog } = await import('../src/main/flog.js')
  flog('first', 'one')
  flog('second', 'two')
  await vi.waitFor(() => expect(fs.appendFile).toHaveBeenCalledTimes(1))
  expect(fs.appendFile.mock.calls[0]?.[1]).toContain('[first] one')
  release()
  await vi.waitFor(() => expect(fs.appendFile).toHaveBeenCalledTimes(2))
  expect(fs.appendFile.mock.calls[1]?.[1]).toContain('[second] two')
})

it('bounds both queued lines and individual entries during a diagnostic burst', async () => {
  const { flog } = await import('../src/main/flog.js')
  for (let index = 0; index < 1000; index++) flog('burst', 'x'.repeat(20_000))
  await vi.waitFor(() => expect(fs.appendFile).toHaveBeenCalledTimes(128))
  expect(fs.appendFile.mock.calls[0]?.[1]).toContain('872 lines omitted')
  expect(fs.appendFile.mock.calls.every((call) => String(call[1]).length < 8400)).toBe(true)
})

it('rotates the log and continues after a failed write', async () => {
  fs.stat.mockResolvedValue({ size: 1_000_001 })
  fs.appendFile.mockRejectedValueOnce(new Error('File temporarily locked'))
  const { flog } = await import('../src/main/flog.js')
  flog('failed-write', 'first')
  flog('next-write', 'second')
  await vi.waitFor(() => expect(fs.appendFile).toHaveBeenCalledTimes(2))
  expect(fs.rename).toHaveBeenCalledTimes(2)
  expect(fs.appendFile.mock.calls[1]?.[1]).toContain('[next-write] second')
})
