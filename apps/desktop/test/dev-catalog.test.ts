import { dirname, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
const send = vi.hoisted(() => vi.fn())
vi.mock('../src/main/engine-cloud.js', () => ({ codexBinary: () => 'fixture', withHelpersOnPath: () => ({}) }))
vi.mock('../src/main/claude-runtime.js', () => ({ loadClaudeSdk: vi.fn() }))
vi.mock('../src/main/dev-rpc.js', () => ({ DevRpc: class { initialize = async () => {}; send = send; shutdown = async () => {} } }))
import { devExternal, devExternalRead, sessionPath } from '../src/main/dev-catalog.js'

it('includes app-created sessions and follows every history page', async () => {
  const cwd = resolve('tmp/project')
  send.mockResolvedValueOnce({ data: [{ id: 'app', name: 'App session', cwd, updatedAt: 1 }], nextCursor: 'second' }).mockResolvedValueOnce({ data: [{ id: 'cli', cwd, updatedAt: 2 }, { id: 'other', cwd: resolve('tmp/other') }], nextCursor: null })
  expect((await devExternal(cwd, 'codex')).map(row => row.id)).toEqual(['app', 'cli'])
  expect(send).toHaveBeenNthCalledWith(1, 'thread/list', expect.objectContaining({ sourceKinds: expect.arrayContaining(['appServer', 'exec']), sortKey: 'updated_at' }), 30_000)
  expect(send).toHaveBeenNthCalledWith(2, 'thread/list', expect.objectContaining({ cursor: 'second' }), 30_000)
  if (process.platform === 'win32') expect(sessionPath('\\\\?\\C:\\project')).toBe(sessionPath('c:/project'))
})

it('finds parent-folder desktop sessions across providers without matching sibling prefixes', async () => {
  send.mockReset()
  const cwd = resolve('tmp/workspace/project')
  send.mockResolvedValueOnce({ data: [{ id: 'parent', cwd: dirname(cwd) }, { id: 'sibling', cwd: `${dirname(cwd)}-other` }] })
  expect((await devExternal(cwd, 'codex')).map(row => row.id)).toEqual(['parent'])
  const params = send.mock.calls[0]![1]
  expect(params.modelProviders).toEqual([])
  expect(params).not.toHaveProperty('cwd')
})

it('keeps background exec tasks out of the all-folder interactive catalog', async () => {
  send.mockReset(); send.mockResolvedValueOnce({ data: [] })
  await devExternal(resolve('tmp/project'), 'codex', true)
  expect(send.mock.calls[0]![1].sourceKinds).not.toContain('exec')
})

it('pages recent conversation text without hydrating the full tool history', async () => {
  send.mockReset()
  const cwd = resolve('tmp/project')
  send.mockResolvedValueOnce({ data: [{ id: 'large', cwd }] })
    .mockResolvedValueOnce({ data: [{ items: [{ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Latest question' }] }, { id: 'a2', type: 'agentMessage', text: 'Latest answer' }] }], nextCursor: 'older' })
    .mockResolvedValueOnce({ data: [{ items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Earlier question' }] }, { id: 'tool', type: 'commandExecution' }, { id: 'a1', type: 'agentMessage', text: 'Earlier answer' }] }], nextCursor: null })
  expect((await devExternalRead(cwd, 'codex', 'large')).map(item => item.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  expect(send).toHaveBeenNthCalledWith(2, 'thread/turns/list', { threadId: 'large', limit: 5, sortDirection: 'desc', itemsView: 'summary' }, 30_000)
  expect(send).toHaveBeenNthCalledWith(3, 'thread/turns/list', expect.objectContaining({ cursor: 'older' }), 30_000)
  expect(send.mock.calls.some(call => call[0] === 'thread/read')).toBe(false)
})
