import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))
vi.mock('../src/main/engine-cloud.js', () => ({ codexBinary: () => 'codex', withHelpersOnPath: () => ({}) }))
import { CodexAccount } from '../src/main/codex-account.js'

function runtime(handle: (method: string, params: Record<string, unknown>, reply: (result: unknown) => void, notify: (params: unknown) => void) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  const requests: string[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    const { id, method, params } = JSON.parse(chunk.toString()) as { id?: number; method: string; params: Record<string, unknown> }
    requests.push(method)
    const write = (data: unknown) => queueMicrotask(() => child.stdout.write(JSON.stringify(data) + '\n'))
    if (method === 'initialize') { expect(params['clientInfo']).toMatchObject({ name: 'engram' }); write({ id, result: {} }); return }
    if (method === 'initialized') return
    handle(method, params, (result) => write({ id, result }), (params) => write({ method: 'account/login/completed', params }))
  })
  fake.spawn.mockReturnValue(child)
  return { child, requests }
}
beforeEach(() => vi.clearAllMocks())
it('discovers paginated visible models after the handshake without opening any work session', async () => {
  const { child, requests } = runtime((method, params, reply) => {
    expect(method).toBe('model/list')
    reply(params['cursor'] ? { data: [{ model: 'beta', displayName: 'Beta' }], nextCursor: null } : {
      data: [{ model: 'alpha', displayName: 'Alpha', description: 'Fast' }, { model: 'hidden', hidden: true }, null], nextCursor: 'more',
    })
  })
  const account = new CodexAccount(new AbortController().signal)
  try {
    expect(await account.models()).toEqual([{ value: 'alpha', label: 'Alpha', detail: 'Fast' }, { value: 'beta', label: 'Beta', detail: '' }])
    expect(requests).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
  } finally { account.close() }
  expect(child.kill).toHaveBeenCalledOnce()
})
it('waits for the matching login completion, including a notification before the response', async () => {
  runtime((method, params, reply, notify) => {
    expect(method).toBe('account/login/start')
    expect(params).toEqual({ type: 'chatgpt' })
    notify({ loginId: 'own', success: true })
    reply({ loginId: 'own', authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' })
  })
  const account = new CodexAccount(new AbortController().signal)
  const onUrl = vi.fn()
  try { await account.login(onUrl); expect(onUrl).toHaveBeenCalledOnce() } finally { account.close() }
})
it('cancels a pending handshake and rejects instead of leaving the settings row spinning', async () => {
  const { child } = runtime(() => undefined)
  const abort = new AbortController()
  const account = new CodexAccount(abort.signal)
  const pending = account.models()
  abort.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(child.kill).toHaveBeenCalledOnce()
})
it('rejects a repeated catalog cursor and a closed login pipe', async () => {
  runtime((_method, _params, reply) => reply({ data: [], nextCursor: 'same' }))
  const account = new CodexAccount(new AbortController().signal)
  try { await expect(account.models()).rejects.toThrow('did not finish') } finally { account.close() }
  const { child } = runtime(() => undefined)
  const next = new CodexAccount(new AbortController().signal)
  const login = next.login(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  child.emit('exit', 1)
  await expect(login).rejects.toThrow('connection closed')
})
