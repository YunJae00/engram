import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ child: undefined as unknown, options: undefined as unknown }))
vi.mock('../src/main/process-client.js', () => ({ ProcessClient: class extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
  constructor(_command: string, _args: string[], options: unknown) { super(); fixture.child = this; fixture.options = options }
  kill() { this.emit('close', null) }
  waitForClose() { return Promise.resolve() }
} }))
import { DevConsole } from '../src/main/dev-console.js'

it('keeps bounded output, persists completed commands and never replays a stopped command', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-console-')), console = new DevConsole(root)
  const pending = console.run(root, 'fixture command')
  const child = fixture.child as EventEmitter & { stdout: PassThrough }
  expect(fixture.options).toMatchObject({ cwd: root, killTree: true })
  await expect(console.run(root, 'second command')).rejects.toThrow('Stop the current')
  child.stdout.write('a'.repeat(210_000)); child.stdout.write(Buffer.from('한글'))
  expect(console.state(root)?.truncated).toBe(true)
  expect(console.state(root)?.output.endsWith('한글')).toBe(true)
  await console.stop(root)
  const result = await pending
  expect(result).toMatchObject({ running: false, stopped: true })
  expect(result.output.length).toBe(200_000)
  expect(JSON.parse(await readFile(result.logPath!, 'utf8')).command).toBe('fixture command')
  expect(new DevConsole(root).state(root)).toBeNull()
})
