import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ calls: [] as unknown[][], children: [] as unknown[] }))
vi.mock('../src/main/process-client.js', () => ({ ProcessClient: class extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  constructor(...args: unknown[]) { super(); fake.calls.push(args); fake.children.push(this) }
} }))
afterEach(() => { vi.resetModules(); fake.calls.length = 0; fake.children.length = 0 })

it('owns the SDK process tree and cancels without waiting for a model response', async () => {
  const { runCodexTurn } = await import('../src/main/codex-turn.js')
  const abort = new AbortController()
  const result = runCodexTurn({ options: {}, thread: {}, input: 'test' }, abort.signal)
  expect(fake.calls[0]![2]).toMatchObject({ killTree: true, signal: abort.signal, env: { ELECTRON_RUN_AS_NODE: '1' } })
  const child = fake.children[0] as { kill: ReturnType<typeof vi.fn> }
  abort.abort(new Error('Stopped by you'))
  await expect(result).rejects.toThrow('Stopped by you')
  expect(child.kill).toHaveBeenCalledOnce()
})
it('returns the SDK response and retires its owned process', async () => {
  const { runCodexTurn } = await import('../src/main/codex-turn.js')
  const result = runCodexTurn({ options: {}, thread: {}, input: 'test' }, new AbortController().signal)
  const child = fake.children[0] as { stdout: PassThrough; kill: ReturnType<typeof vi.fn> }
  child.stdout.write(JSON.stringify({ text: 'Done' }) + '\n')
  await expect(result).resolves.toBe('Done')
  expect(child.kill).toHaveBeenCalledOnce()
})
