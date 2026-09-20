import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
const send = vi.hoisted(() => vi.fn())
vi.mock('../src/main/engine-cloud.js', () => ({ codexBinary: () => 'fixture', withHelpersOnPath: () => ({}) }))
vi.mock('../src/main/claude-runtime.js', () => ({ loadClaudeSdk: vi.fn() }))
vi.mock('../src/main/dev-rpc.js', () => ({ DevRpc: class { initialize = async () => {}; send = send; shutdown = async () => {} } }))
import { devExternal, sessionPath } from '../src/main/dev-catalog.js'

it('includes app-created sessions and follows every history page', async () => {
  const cwd = resolve('tmp/project')
  send.mockResolvedValueOnce({ data: [{ id: 'app', name: 'App session', cwd, updatedAt: 1 }], nextCursor: 'second' }).mockResolvedValueOnce({ data: [{ id: 'cli', cwd, updatedAt: 2 }, { id: 'other', cwd: resolve('tmp/other') }], nextCursor: null })
  expect((await devExternal(cwd, 'codex')).map(row => row.id)).toEqual(['app', 'cli'])
  expect(send).toHaveBeenNthCalledWith(1, 'thread/list', expect.objectContaining({ sourceKinds: expect.arrayContaining(['appServer', 'exec']), sortKey: 'updated_at' }), 30_000)
  expect(send).toHaveBeenNthCalledWith(2, 'thread/list', expect.objectContaining({ cursor: 'second' }), 30_000)
  if (process.platform === 'win32') expect(sessionPath('\\\\?\\C:\\project')).toBe(sessionPath('c:/project'))
})
