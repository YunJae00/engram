import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('streams through a worker, preserves exit/errors, and cancels during startup', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const outdir = await mkdtemp(resolve('tmp/process-test-'))
  await writeFile(join(outdir, 'package.json'), '{"type":"module"}')
  await build({ entryPoints: ['apps/desktop/src/main/process-client.ts', 'apps/desktop/src/main/process-worker.ts'], outdir, platform: 'node', format: 'esm' })
  const { ProcessClient } = await import(pathToFileURL(join(outdir, 'process-client.js')).href) as typeof import('../src/main/process-client.js')
  const child = new ProcessClient(process.execPath, ['-e', "process.stdin.pipe(process.stdout); process.stderr.write('diagnostic')"])
  const closed = once(child, 'close')
  let out = '', diagnostic = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { diagnostic += data })
  child.stdin.end('hello'.repeat(20000))
  expect(await closed).toEqual([0, null])
  expect(out).toBe('hello'.repeat(20000))
  expect(diagnostic).toBe('diagnostic')
  expect(child.exitCode).toBe(0)
  expect(child.kill()).toBe(false)

  const missing = new ProcessClient(join(outdir, 'missing-executable'), [])
  const failed = new Promise<void>(resolve => missing.once('close', () => resolve()))
  const error = once(missing, 'error')
  expect((await error)[0]).toMatchObject({ code: 'ENOENT' })
  await failed

  const abort = new AbortController()
  const cancelled = new ProcessClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal })
  cancelled.stdout.resume(); cancelled.stderr.resume()
  const stopped = once(cancelled, 'close')
  abort.abort()
  await stopped
  expect(cancelled.killed).toBe(true)

  const blocked = new ProcessClient(process.execPath, ['-e', "process.stdout.write('x'.repeat(1000000)); setInterval(() => {}, 1000)"])
  blocked.stderr.resume()
  await once(blocked.stdout, 'readable')
  const drained = once(blocked, 'close')
  blocked.stdout.destroy()
  blocked.stdin.end()
  blocked.kill()
  await drained
}, 120000)
