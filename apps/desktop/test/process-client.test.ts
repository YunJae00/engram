import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'

it('streams through a worker, preserves exit/errors, and cancels during startup', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const outdir = await mkdtemp(resolve('tmp/process-test-'))
  await writeFile(join(outdir, 'package.json'), '{"type":"module"}')
  await build({ entryPoints: ['apps/desktop/src/main/process-client.ts', 'apps/desktop/src/main/process-worker.ts'], outdir, platform: 'node', format: 'esm' })
  const { ProcessClient, runtimeProcessesRunning, stopRuntimeProcesses } = await import(pathToFileURL(join(outdir, 'process-client.js')).href) as typeof import('../src/main/process-client.js')
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

  if (process.platform === 'win32') {
    const tree = new ProcessClient(process.execPath, ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000)"], { killTree: true })
    tree.stderr.resume()
    const closedTree = once(tree, 'close')
    try {
      const [data] = await once(tree.stdout, 'data')
      const ownedPid = Number(String(data).trim())
      expect(Number.isInteger(ownedPid) && ownedPid > 0).toBe(true)
      tree.kill()
      await closedTree
      await vi.waitFor(() => expect(() => process.kill(ownedPid, 0)).toThrow(), { timeout: 5000 })
    } finally { tree.kill() }
  }
  const background = new ProcessClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  background.stdout.resume(); background.stderr.resume()
  expect(runtimeProcessesRunning()).toBe(true)
  await stopRuntimeProcesses()
  expect(runtimeProcessesRunning()).toBe(false)
  expect(background.killed).toBe(true)
  expect(() => new ProcessClient(process.execPath, [])).toThrow('closing')
}, 120000)
