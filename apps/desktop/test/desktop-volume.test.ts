import { readFileSync } from 'node:fs'
import { exec, execFile, execSync, spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { systemVolumeTool } from '../src/main/desktop-volume.js'
import { desktopOptIn } from '../src/main/desktop-opt-in.js'
import { shapeOf } from '../src/main/engine-claude-tools.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) =>
    callback(null, 'output volume:30, input volume:50, alert volume:100, output muted:false', '')),
  exec: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

const ctx = { task: 'set volume to 30%' }
const fake = (level: number | null, muted: boolean | null = false) => vi.fn(async (args: string[]) => args[1] === 'get volume settings'
  ? `output volume:${level ?? 'missing value'}, input volume:50, alert volume:100, output muted:${muted ?? 'missing value'}`
  : '')
const realPlatform = process.platform
const asPlatform = (value: string) => Object.defineProperty(process, 'platform', { value })
afterEach(() => { asPlatform(realPlatform); vi.mocked(execFile).mockClear() })

it('sets and reads back the volume', async () => {
  const run = fake(30)
  await expect(systemVolumeTool(run, 'darwin').run({ action: 'set', percent: 30 }, ctx)).resolves.toContain('30%')
  expect(run.mock.calls.map(call => call[0])).toEqual([['-e', 'set volume output volume 30'], ['-e', 'get volume settings']])
  await expect(systemVolumeTool(fake(31), 'darwin').run({ action: 'set', percent: 30 }, ctx)).resolves.toContain('macOS reports 31%')
  const read = fake(42)
  await expect(systemVolumeTool(read, 'darwin').run({ action: 'get' }, ctx)).resolves.toBe('Output volume is 42%.')
  expect(read).toHaveBeenCalledOnce()
})

it('clamps and rejects bad input', async () => {
  const high = fake(100)
  await expect(systemVolumeTool(high, 'darwin').run({ action: 'set', percent: 150 }, ctx)).resolves.toContain('clamped to 100')
  expect(high.mock.calls[0]?.[0]).toEqual(['-e', 'set volume output volume 100'])
  const low = fake(0)
  await systemVolumeTool(low, 'darwin').run({ action: 'set', percent: -5 }, ctx)
  expect(low.mock.calls[0]?.[0]).toEqual(['-e', 'set volume output volume 0'])
  for (const percent of ['abc', '30', undefined, Number.NaN]) {
    const run = fake(30)
    await expect(systemVolumeTool(run, 'darwin').run({ action: 'set', percent }, ctx)).rejects.toThrow('percent must be a number')
    expect(run).not.toHaveBeenCalled()
  }
  await expect(systemVolumeTool(fake(30), 'darwin').run({ action: 'louder' }, ctx)).rejects.toThrow('action must be')
  const percent = shapeOf(systemVolumeTool(async () => '', 'darwin').argsSchema)['percent']!
  expect(percent.safeParse(150).success).toBe(true)
  expect(percent.safeParse(-5).success).toBe(true)
})

it('never runs a shell string', async () => {
  asPlatform('darwin')
  await expect(systemVolumeTool().run({ action: 'get' }, ctx)).resolves.toBe('Output volume is 30%.')
  const [file, args, options] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], { shell?: unknown }]
  expect(file).toBe('osascript')
  expect(args).toEqual(['-e', 'get volume settings'])
  expect(options.shell).toBeUndefined()
  expect(exec).not.toHaveBeenCalled(); expect(execSync).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync('apps/desktop/src/main/desktop-volume.ts', 'utf8')).not.toMatch(/\bexec(Sync)?\(|shell:\s*true|\bspawn\(/)
})

it('needs no app control approval', async () => {
  asPlatform('darwin')
  const consent = { enabled: vi.fn(async () => false), enable: vi.fn(async () => {}), ask: vi.fn(async () => 'cancel' as const) }
  const tools = desktopOptIn([{ name: 'list_apps', description: 'List apps', argsSchema: {}, run: async () => 'apps' }], consent)
  const volume = tools.find(tool => tool.name === 'system_volume')!
  await expect(volume.run({ action: 'mute' }, ctx)).resolves.toContain('Output volume is now 30%')
  expect(consent.ask).not.toHaveBeenCalled(); expect(consent.enable).not.toHaveBeenCalled(); expect(consent.enabled).not.toHaveBeenCalled()
  expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toContainEqual(['-e', 'set volume output muted true'])
  expect(desktopOptIn([], consent).map(tool => tool.name)).toContain('system_volume')
})

it.each([['win32', 'Windows'], ['linux', 'Linux']] as const)('reports volume control unsupported on %s', async (platform, label) => {
  const run = fake(30)
  await expect(systemVolumeTool(run, platform).run({ action: 'set', percent: 30 }, ctx)).resolves.toContain(`not supported on ${label}`)
  expect(run).not.toHaveBeenCalled()
})

it('reports mute state and devices without a level', async () => {
  await expect(systemVolumeTool(fake(30, true), 'darwin').run({ action: 'mute' }, ctx)).resolves.toBe('Output volume is now 30% and muted.')
  await expect(systemVolumeTool(fake(30, true), 'darwin').run({ action: 'unmute' }, ctx)).resolves.toContain('did not take effect')
  await expect(systemVolumeTool(fake(null, null), 'darwin').run({ action: 'get' }, ctx)).resolves.toContain('no software volume control')
  await expect(systemVolumeTool(async () => 'garbage', 'darwin').run({ action: 'get' }, ctx)).rejects.toThrow('Could not read the output volume')
})

it('changes nothing after Stop', async () => {
  const run = fake(30)
  const controller = new AbortController(); controller.abort()
  await expect(systemVolumeTool(run, 'darwin').run({ action: 'set', percent: 30 }, { ...ctx, signal: controller.signal })).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})
