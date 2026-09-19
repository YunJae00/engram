import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ child: null as unknown, args: [] as string[] }))
vi.mock('../src/main/process-client.js', () => ({ ProcessClient: function (_binary: string, args: string[]) { fake.args = args; return fake.child } }))
import { DevRpc } from '../src/main/dev-rpc.js'

function runtime() {
  const sent: Record<string, unknown>[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    stdin: new Writable({ write(chunk, _encoding, callback) { sent.push(JSON.parse(chunk.toString())); callback() } }),
  })
  fake.child = child
  return { child, sent, reply: (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n') }
}
afterEach(() => vi.useRealTimers())

it('separates server requests from responses even when identifiers coincide', async () => {
  const test = runtime(), notify = vi.fn(), ended = vi.fn(), approve = vi.fn(async () => ({ decision: 'decline' }))
  const rpc = new DevRpc('runtime', { cwd: '.', env: {} }, notify, approve, ended)
  expect(fake.args).toContain('features.hooks=false')
  expect(fake.args).toContain('projects.".".trust_level="untrusted"')
  const result = rpc.send('thread/read', { threadId: 'owned' })
  test.reply({ id: 1, method: 'item/fileChange/requestApproval', params: { itemId: 'edit' } })
  await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
  test.reply({ id: 1, result: { thread: { id: 'owned' } } })
  expect(await result).toEqual({ thread: { id: 'owned' } })
  expect(test.sent).toContainEqual({ id: 1, result: { decision: 'decline' } })
  rpc.close()
  expect(ended).toHaveBeenCalledOnce()
  expect(test.child.kill).toHaveBeenCalledOnce()
})

it('closes on timeout and rejects other pending requests instead of leaving an uncertain runtime active', async () => {
  vi.useFakeTimers()
  const test = runtime(), ended = vi.fn()
  const rpc = new DevRpc('runtime', { cwd: '.', env: {} }, vi.fn(), async () => ({ decision: 'decline' }), ended)
  const first = rpc.send('turn/start', {}, 100).catch(error => error.message)
  const second = rpc.send('thread/read', {}).catch(error => error.message)
  await vi.advanceTimersByTimeAsync(101)
  expect(await first).toContain('did not respond')
  expect(await second).toContain('did not respond')
  expect(test.child.kill).toHaveBeenCalledOnce()
  expect(ended).toHaveBeenCalledOnce()
})
