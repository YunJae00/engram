import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Browser } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { NativeBrowser } from '../src/main/native-browser.js'

it('closes the host even when the browser disconnect never settles', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(),
  })
  const helper = new NativeBrowser(child as unknown as ChildProcessWithoutNullStreams)
  const disconnect = vi.fn(() => new Promise<void>(() => undefined))
  helper.browser = { close: disconnect } as unknown as Browser
  try {
    child.stdout.write('{"type":"ready"}\n')
    await helper.ready
    const closing = helper.close()
    expect(helper.close()).toBe(closing)
    expect(child.stdin.writableEnded).toBe(true)
    child.exitCode = 0
    child.emit('exit', 0)
    await closing
    expect(disconnect).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})
