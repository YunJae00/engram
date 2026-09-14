import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const fake = vi.hoisted(() => ({ data: '', handlers: new Map<string, (...args: unknown[]) => unknown>(), run: vi.fn(), enabled: true }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => fake.data, getPath: () => fake.data, once: () => {} }, ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => fake.handlers.set(name, callback) } }))
vi.mock('node:os', () => ({ homedir: () => fake.data }))
vi.mock('../src/main/engine-cloud.js', () => ({ claudeBinary: () => 'claude-runtime', codexBinary: () => 'codex-runtime', runText: fake.run }))
vi.mock('../src/main/external-connection.js', () => ({ externalInfoPath: () => join(fake.data, 'external-connection.json'), externalStatus: () => ({ enabled: fake.enabled }), setExternalEnabled: async () => {}, stopExternalCalls: () => {} }))
import { registerMcpIpc } from '../src/main/mcp-connect.js'
afterEach(() => vi.unstubAllEnvs())

beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fake.data = await mkdtemp(resolve('tmp/mcp-config-'))
  vi.stubEnv('APPDATA', fake.data)
  await mkdir(join(fake.data, 'bundle', 'mcp'), { recursive: true })
  await writeFile(join(fake.data, 'bundle', 'mcp', 'engram-mcp.cjs'), '')
  fake.enabled = true; fake.run.mockReset(); fake.handlers.clear()
  registerMcpIpc()
})

it('preserves broken or unrelated client configuration and backs up an owned entry before replacement', async () => {
  const info = await fake.handlers.get('mcp:info')!() as { desktopConfigPath: string }
  const target = info.desktopConfigPath
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, '{broken')
  expect(await fake.handlers.get('mcp:connectDesktop')!()).toMatchObject({ ok: false })
  expect(await readFile(target, 'utf8')).toBe('{broken')
  const foreign = JSON.stringify({ mcpServers: { engram: { command: 'other' } }, preference: 1 })
  await writeFile(target, foreign)
  expect(await fake.handlers.get('mcp:connectDesktop')!()).toMatchObject({ ok: false })
  expect(await readFile(target, 'utf8')).toBe(foreign)
  const old = { preference: 1, mcpServers: { engram: { command: 'engram', args: ['engram-mcp.cjs', '--registry', 'vaults.json'] }, unrelated: { command: 'keep' } } }
  await writeFile(target, JSON.stringify(old))
  expect(await fake.handlers.get('mcp:connectDesktop')!()).toEqual({ ok: true })
  const saved = JSON.parse(await readFile(target, 'utf8'))
  expect(saved.preference).toBe(1)
  expect(saved.mcpServers.unrelated).toEqual({ command: 'keep' })
  expect(saved.mcpServers.engram.args).toContain('--bridge')
  expect((await readdir(join(target, '..'))).some(name => name.endsWith('.bak'))).toBe(true)
})

it('uses argv-based Codex registration only after explicit enablement and never registers at boot', async () => {
  expect(fake.run).not.toHaveBeenCalled()
  fake.enabled = false
  expect(await fake.handlers.get('mcp:connectCodex')!()).toMatchObject({ ok: false })
  expect(fake.run).not.toHaveBeenCalled()
  fake.enabled = true
  fake.run.mockResolvedValueOnce({ code: 1, out: 'not found' }).mockResolvedValueOnce({ code: 0, out: 'added' })
  expect(await fake.handlers.get('mcp:connectCodex')!()).toEqual({ ok: true })
  expect(fake.run.mock.calls[1]?.[1]).toEqual(['mcp', 'add', 'engram', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', process.execPath, join(fake.data, 'bundle', 'mcp', 'engram-mcp.cjs'), '--bridge', join(fake.data, 'external-connection.json')])
})

it('restores an owned legacy Claude configuration if registration fails after removal', async () => {
  const file = join(fake.data, '.claude.json')
  const original = JSON.stringify({ preference: 'keep', mcpServers: { engram: { command: 'engram', args: ['engram-mcp.cjs', '--registry', 'vaults.json'] } } })
  await writeFile(file, original)
  fake.run.mockResolvedValueOnce({ code: 0, out: 'Args: engram-mcp.cjs --registry vaults.json' })
    .mockImplementationOnce(async () => { await writeFile(file, JSON.stringify({ preference: 'keep', mcpServers: {} })); return { code: 0, out: 'removed' } })
    .mockResolvedValueOnce({ code: 1, out: 'failed' })
  expect(await fake.handlers.get('mcp:connectCode')!()).toMatchObject({ ok: false })
  expect(await readFile(file, 'utf8')).toBe(original)
})
